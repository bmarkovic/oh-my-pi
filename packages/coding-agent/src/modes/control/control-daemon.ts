/**
 * The daemon's state and the operations that create and describe sessions. One
 * daemon serves every principal; the registry keeps each handle principal-owned.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { buildControlCatalog, catalogModelId, type ControlCatalogSource } from "./control-catalog";
import type { ControlPrincipal } from "./control-auth";
import type { ControlConnection, ControlOperationHandler } from "./control-connection";
import { CONTROL_OPERATIONS, defineOperation } from "./control-operations";
import type { ControlSessionFactory, ControlSessionHandle } from "./control-session-factory";
import { ControlSessionRegistry } from "./control-session-registry";
import { ControlTurnController } from "./control-turn";
import { ackFrame, subscribeEventsCommand } from "./wire/envelope";
import type { ControlEvent } from "./wire/events";
import {
	type CreateSessionCommand,
	catalogFrame,
	createSessionCommand,
	type PromptSessionCommand,
	promptSessionCommand,
	interruptSessionCommand,
	queryCatalogCommand,
	sessionCreatedFrame,
} from "./wire/commands";

/** Turn budget when `create_session` omits `timeoutMs` (contract section 2.2). */
export const DEFAULT_TURN_TIMEOUT_MS = 1_800_000;

export interface ControlDaemonOptions {
	catalog: ControlCatalogSource;
	createSession: ControlSessionFactory;
	/** Directory the catalog's agent discovery runs from. */
	daemonCwd: string;
}

export class ControlDaemon {
	readonly #catalog: ControlCatalogSource;
	readonly #createSession: ControlSessionFactory;
	readonly #daemonCwd: string;
	readonly #registry = new ControlSessionRegistry();
	readonly #turns: ControlTurnController;
	/** Connections that subscribed; pruned lazily once closed. */
	readonly #subscribers = new Set<ControlConnection>();

	constructor(options: ControlDaemonOptions) {
		this.#catalog = options.catalog;
		this.#createSession = options.createSession;
		this.#daemonCwd = options.daemonCwd;
		this.#turns = new ControlTurnController((principal, frame) => this.#publish(principal, frame));
	}

	/** The command table for this daemon: the base operations plus the session operations. */
	operations(): ReadonlyMap<string, ControlOperationHandler> {
		return new Map<string, ControlOperationHandler>([
			...CONTROL_OPERATIONS,
			[
				"subscribe_events",
				defineOperation({
					schema: subscribeEventsCommand,
					run: (connection, id) => {
						connection.subscribe();
						this.#subscribers.add(connection);
						connection.reply(ackFrame(id));
					},
				}),
			],
			[
				"interrupt_session",
				defineOperation({
					schema: interruptSessionCommand,
					requiresSubscription: true,
					run: (connection, id, command) => {
						const record = this.#registry.lookup(connection.principal, command.sessionId);
						if (!record) {
							connection.reject("unknown_session", "session is not retained", id);
							return;
						}
						// Ack first: the interrupted outcome is published only after the run has unwound.
						connection.reply(ackFrame(id));
						this.#turns.interrupt(record);
					},
				}),
			],
			[
				"prompt_session",
				defineOperation({
					schema: promptSessionCommand,
					requiresSubscription: true,
					run: (connection, id, command) => this.#promptSession(connection, id, command),
				}),
			],
			[
				"query_catalog",
				defineOperation({
					schema: queryCatalogCommand,
					run: async (connection, id) => {
						const catalog = await buildControlCatalog(this.#catalog, this.#daemonCwd);
						connection.reply(catalogFrame(id, catalog));
					},
				}),
			],
			[
				"create_session",
				defineOperation({
					schema: createSessionCommand,
					requiresSubscription: true,
					run: (connection, id, command) => this.#createSessionFor(connection, id, command),
				}),
			],
		]);
	}

	/** Dispose every retained session. Called once at shutdown. */
	async dispose(): Promise<void> {
		await this.#registry.disposeAll();
	}

	/** Deliver an event to every subscribed connection of the owning principal. */
	#publish(principal: ControlPrincipal, frame: ControlEvent): void {
		for (const connection of this.#subscribers) {
			if (connection.closed) {
				this.#subscribers.delete(connection);
				continue;
			}
			if (connection.principal === principal && connection.subscribed) connection.reply(frame);
		}
	}

	async #promptSession(connection: ControlConnection, id: string, command: PromptSessionCommand): Promise<void> {
		const record = this.#registry.lookup(connection.principal, command.sessionId);
		if (!record) {
			connection.reject("unknown_session", "session is not retained", id);
			return;
		}
		if (command.tools !== undefined && command.tools.length > 0) {
			connection.reject("unsupported_operation", "tool bindings are not supported by this build", id);
			return;
		}
		if (record.turn !== undefined) {
			try {
				await this.#turns.steer(record, command.prompt);
			} catch (error) {
				connection.reject("unsupported_operation", `steering was refused: ${String(error)}`, id);
				return;
			}
			connection.reply(ackFrame(id));
			return;
		}
		// Ack first: the turn starts synchronously after it, so no await separates the state change from the ack.
		connection.reply(ackFrame(id));
		this.#turns.start(record, command.prompt, command.operatorUserId);
	}

	async #createSessionFor(connection: ControlConnection, id: string, command: CreateSessionCommand): Promise<void> {
		if (!path.isAbsolute(command.workspacePath) || !(await isReadableDirectory(command.workspacePath))) {
			connection.reject("invalid_workspace", "workspacePath must be an existing, readable absolute directory", id);
			return;
		}
		const timeoutMs = command.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
		if (!Number.isSafeInteger(timeoutMs)) {
			connection.reject("invalid_message", "timeoutMs must be a positive safe integer", id);
			return;
		}
		if (command.tools !== undefined && command.tools.length > 0) {
			connection.reject("unsupported_operation", "tool bindings are not supported by this build", id);
			return;
		}

		// Resolve every selection before any side effect, so a bad selection creates nothing.
		const agent =
			command.agent === undefined
				? undefined
				: (await this.#catalog.agents(command.workspacePath)).find(candidate => candidate.name === command.agent);
		if (command.agent !== undefined && agent === undefined) {
			connection.reject("unknown_agent", "agent is not in the catalog", id);
			return;
		}
		const model: Model | undefined =
			command.model === undefined
				? undefined
				: this.#catalog.models().find(candidate => catalogModelId(candidate) === command.model);
		if (command.model !== undefined && model === undefined) {
			connection.reject("unknown_model", "model is not in the catalog", id);
			return;
		}

		let handle: ControlSessionHandle;
		try {
			handle = await this.#createSession({ cwd: command.workspacePath, agent, model });
		} catch (error) {
			logger.warn("control session creation failed", { error: String(error) });
			connection.reject("invalid_message", "session could not be created", id);
			return;
		}
		const sessionId = crypto.randomUUID();
		this.#registry.register({
			sessionId,
			principal: connection.principal,
			taskRef: command.taskRef,
			timeoutMs,
			state: "idle",
			session: handle.session,
		});
		connection.reply(sessionCreatedFrame(id, sessionId));
	}
}

/** True when `target` is an existing directory the daemon can read. */
async function isReadableDirectory(target: string): Promise<boolean> {
	try {
		const stats = await fs.stat(target);
		if (!stats.isDirectory()) return false;
		await fs.access(target, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}
