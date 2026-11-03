/**
 * The daemon's state and every operation a control client can run. One daemon
 * serves every principal; the registry keeps each handle owned by its principal.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { buildControlCatalog, type ControlCatalogSource, catalogModelId } from "./control-catalog";
import type { ControlPrincipal } from "./control-auth";
import type { ControlConnection, ControlOperationHandler } from "./control-connection";
import { CONTROL_OPERATIONS, defineOperation } from "./control-operations";
import { type ControlToolBinding, createEndpointTool, parseToolBindings } from "./control-endpoint-tool";
import type { ControlSessionFactory, ControlSessionHandle } from "./control-session-factory";
import type { SubagentUiAssignment, SubagentUiChild, SubagentUiRouter } from "../../task/types";
import { ControlChildLedger } from "./control-children";
import { ControlDecisionStore } from "./control-decisions";
import { createControlExtensionUI } from "./control-ui-context";
import { ControlSessionRegistry } from "./control-session-registry";
import { ControlTurnController } from "./control-turn";
import {
	type CreateSessionCommand,
	catalogFrame,
	childSessionsFrame,
	enumerateChildSessionsCommand,
	createSessionCommand,
	answerDecisionCommand,
	interruptSessionCommand,
	type PromptSessionCommand,
	promptSessionCommand,
	queryCatalogCommand,
	sessionCreatedFrame,
	terminateSessionCommand,
} from "./wire/commands";
import { ackFrame, subscribeEventsCommand } from "./wire/envelope";
import type { ControlEvent } from "./wire/events";

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
	readonly #decisions: ControlDecisionStore;
	readonly #children: ControlChildLedger;
	/** Connections that subscribed; pruned lazily once closed. */
	readonly #subscribers = new Set<ControlConnection>();

	constructor(options: ControlDaemonOptions) {
		this.#catalog = options.catalog;
		this.#createSession = options.createSession;
		this.#daemonCwd = options.daemonCwd;
		const publish = (principal: ControlPrincipal, frame: ControlEvent) => this.#publish(principal, frame);
		this.#decisions = new ControlDecisionStore(publish);
		this.#children = new ControlChildLedger({ publish, decisions: this.#decisions, registry: this.#registry });
		this.#turns = new ControlTurnController(publish, this.#decisions, this.#children);
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
			[
				"prompt_session",
				defineOperation({
					schema: promptSessionCommand,
					requiresSubscription: true,
					run: (connection, id, command) => this.#promptSession(connection, id, command),
				}),
			],
			[
				"answer_decision",
				defineOperation({
					schema: answerDecisionCommand,
					requiresSubscription: true,
					run: (connection, id, command) => {
						const result = this.#decisions.answer(connection.principal, command);
						if (result.kind === "rejected") {
							connection.reject(result.code, result.message, id);
							return;
						}
						// Ack before the decision event; the continuation resumes only after that event.
						connection.reply(ackFrame(id));
						if (result.kind === "accepted") this.#decisions.release(result.decisionId);
					},
				}),
			],
			[
				"enumerate_child_sessions",
				defineOperation({
					schema: enumerateChildSessionsCommand,
					run: (connection, id, command) => {
						const parent = this.#registry.lookup(connection.principal, command.parentSessionId);
						if (!parent) {
							connection.reject("unknown_session", "session is not retained", id);
							return;
						}
						connection.reply(childSessionsFrame(id, parent.sessionId, [...parent.children]));
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
						if (record.parentSessionId !== undefined) {
							connection.reject(
								"unsupported_operation",
								"child sessions are controlled through their parent",
								id,
							);
							return;
						}
						if (record.state === "terminated") {
							connection.reject("unsupported_operation", "session has already been terminated", id);
							return;
						}
						// Ack first: the interrupted outcome is published only after the run has unwound.
						connection.reply(ackFrame(id));
						this.#turns.interrupt(record);
					},
				}),
			],
			[
				"terminate_session",
				defineOperation({
					schema: terminateSessionCommand,
					requiresSubscription: true,
					run: (connection, id, command) => {
						const record = this.#registry.lookup(connection.principal, command.sessionId);
						if (!record) {
							connection.reject("unknown_session", "session is not retained", id);
							return;
						}
						if (record.parentSessionId !== undefined) {
							connection.reject(
								"unsupported_operation",
								"child sessions are controlled through their parent",
								id,
							);
							return;
						}
						if (record.state === "terminated") {
							connection.reject("unsupported_operation", "session has already been terminated", id);
							return;
						}
						connection.reply(ackFrame(id));
						void this.#turns.terminate(record);
					},
				}),
			],
		]);
	}

	/**
	 * Give a subagent its parent's control scope: its questions become decisions carrying the
	 * parent's handle, and it receives the parent's tool bindings. Undefined once the parent is gone.
	 */
	#routeSubagent(parentId: string, child: SubagentUiChild): SubagentUiAssignment | undefined {
		const parent = this.#registry.find(parentId);
		if (!parent || parent.state === "terminated") return undefined;
		const childId = crypto.randomUUID();
		this.#children.adopt(parent, child.session, childId);
		return {
			uiContext: createControlExtensionUI({
				sessionId: childId,
				principal: parent.principal,
				decisions: this.#decisions,
				parentSessionId: parent.sessionId,
			}),
			tools: parent.tools.map(createEndpointTool),
		};
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

	/** Run one prompt-class command after every earlier command on the same session. */
	#inLane(record: { lane: Promise<void> }, task: () => Promise<void>): Promise<void> {
		const run = record.lane.then(task);
		record.lane = run.catch(() => undefined);
		return run;
	}

	async #promptSession(connection: ControlConnection, id: string, command: PromptSessionCommand): Promise<void> {
		const record = this.#registry.lookup(connection.principal, command.sessionId);
		if (!record) {
			connection.reject("unknown_session", "session is not retained", id);
			return;
		}
		if (record.parentSessionId !== undefined) {
			connection.reject("unsupported_operation", "child sessions are controlled through their parent", id);
			return;
		}
		if (record.state === "terminated") {
			connection.reject("unsupported_operation", "session has already been terminated", id);
			return;
		}
		await this.#inLane(record, async () => {
			if (command.tools !== undefined) {
				if (record.turn !== undefined) {
					connection.reject("invalid_message", "tool bindings cannot change during an active turn", id);
					return;
				}
				let bindings: ControlToolBinding[];
				try {
					bindings = parseToolBindings(command.tools);
				} catch (error) {
					connection.reject("invalid_message", describeValidation(error), id);
					return;
				}
				try {
					// Atomic: the replacement is validated whole before any binding is installed.
					await record.session.refreshRpcHostTools(bindings.map(createEndpointTool));
				} catch (error) {
					connection.reject(
						"invalid_message",
						`tool bindings could not be installed: ${describeValidation(error)}`,
						id,
					);
					return;
				}
				record.tools = bindings;
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
		});
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
		let bindings: ControlToolBinding[] = [];
		if (command.tools !== undefined) {
			try {
				bindings = parseToolBindings(command.tools);
			} catch (error) {
				connection.reject("invalid_message", describeValidation(error), id);
				return;
			}
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

		const sessionId = crypto.randomUUID();
		let handle: ControlSessionHandle;
		try {
			handle = await this.#createSession({
				cwd: command.workspacePath,
				agent,
				model,
				subagentUi: child => this.#routeSubagent(sessionId, child),
			});
		} catch (error) {
			logger.warn("control session creation failed", { error: String(error) });
			connection.reject("invalid_message", "session could not be created", id);
			return;
		}
		if (bindings.length > 0) {
			try {
				await handle.session.refreshRpcHostTools(bindings.map(createEndpointTool));
			} catch (error) {
				logger.warn("control tool bindings could not be installed", { error: String(error) });
				await handle.session.dispose().catch(() => undefined);
				connection.reject(
					"invalid_message",
					`tool bindings could not be installed: ${describeValidation(error)}`,
					id,
				);
				return;
			}
		}
		// Questions the session's tools ask a human become decisions owned by this principal.
		handle.setToolUIContext(
			createControlExtensionUI({ sessionId, principal: connection.principal, decisions: this.#decisions }),
			true,
		);
		this.#registry.register({
			sessionId,
			principal: connection.principal,
			taskRef: command.taskRef,
			timeoutMs,
			state: "idle",
			session: handle.session,
			tools: bindings,
			lane: Promise.resolve(),
			children: [],
		});
		connection.reply(sessionCreatedFrame(id, sessionId));
	}
}

/** Describe a validation failure without echoing values: binding errors name fields only. */
function describeValidation(error: unknown): string {
	return error instanceof Error && error.message.length > 0 ? error.message : "invalid tool bindings";
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
