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
import type { SubagentUiAssignment, SubagentUiChild } from "../../task/types";
import { ControlChildLedger } from "./control-children";
import { ControlRetention, type ControlRetentionTiming, DEFAULT_RETENTION_TIMING } from "./control-retention";
import {
	reconciledFrame,
	sessionInspectedFrame,
	inspectSessionCommand,
	reconnectCommand,
	type ReconnectEntry,
} from "./wire/commands";
import { snapshotOf, type ControlReconciliationResult } from "./control-reconcile";
import type { ControlSessionRecord } from "./control-session-registry";
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
	/** Retention clocks; defaults follow the shared wire profile. */
	retention?: Partial<ControlRetentionTiming>;
}

/** A retired handle answers only `unsupported_operation` until it is forgotten. */
function isRetired(record: ControlSessionRecord): boolean {
	return record.state === "terminated" || record.state === "expired";
}

export class ControlDaemon {
	readonly #catalog: ControlCatalogSource;
	readonly #createSession: ControlSessionFactory;
	readonly #daemonCwd: string;
	readonly #registry = new ControlSessionRegistry();
	readonly #turns: ControlTurnController;
	readonly #decisions: ControlDecisionStore;
	readonly #children: ControlChildLedger;
	readonly #retention: ControlRetention;
	/** Open authenticated connections per principal. */
	readonly #connections = new Map<ControlPrincipal, number>();
	/** Connections that subscribed; pruned lazily once closed. */
	readonly #subscribers = new Set<ControlConnection>();

	constructor(options: ControlDaemonOptions) {
		this.#catalog = options.catalog;
		this.#createSession = options.createSession;
		this.#daemonCwd = options.daemonCwd;
		const timing: ControlRetentionTiming = { ...DEFAULT_RETENTION_TIMING, ...options.retention };
		this.#retention = new ControlRetention(timing, {
			expireIdle: sessionId => this.#expireIdle(sessionId),
			forget: sessionId => this.#forget(sessionId),
			reclaimOrphans: principal => this.#reclaimOrphans(principal),
		});
		const publish = (principal: ControlPrincipal, frame: ControlEvent) => this.#publish(principal, frame);
		this.#decisions = new ControlDecisionStore(publish, timing.tombstoneRetentionMs);
		this.#children = new ControlChildLedger({ publish, decisions: this.#decisions, registry: this.#registry });
		this.#turns = new ControlTurnController(publish, this.#decisions, this.#children, this.#retention);
	}

	/**
	 * A principal's connection opened or closed. When its last connection closes, its
	 * sessions are reclaimed after the orphan grace period unless it reconnects first.
	 */
	connectionChanged(principal: ControlPrincipal, opened: boolean): void {
		const count = (this.#connections.get(principal) ?? 0) + (opened ? 1 : -1);
		if (count > 0) {
			this.#connections.set(principal, count);
			if (opened) this.#retention.cancelOrphanGrace(principal);
			return;
		}
		this.#connections.delete(principal);
		this.#retention.armOrphanGrace(principal);
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
				"inspect_session",
				defineOperation({
					schema: inspectSessionCommand,
					run: (connection, id, command) => {
						const record = this.#registry.lookup(connection.principal, command.sessionId);
						if (!record) {
							connection.reject("unknown_session", "session is not retained", id);
							return;
						}
						// Side-effect free: inspecting never resets the idle clock or the deadline.
						connection.reply(
							sessionInspectedFrame(id, record.sessionId, snapshotOf(record, this.#registry, this.#decisions)),
						);
					},
				}),
			],
			[
				"reconnect",
				defineOperation({
					schema: reconnectCommand,
					requiresSubscription: true,
					run: (connection, id, command) => {
						let entries: ReconnectEntry[];
						try {
							entries = parseReconnectEntries(command.activeSessions);
						} catch (error) {
							connection.reject("invalid_message", describeValidation(error), id);
							return;
						}
						const sessions: ControlReconciliationResult[] = entries.map(entry => {
							const record = this.#registry.lookup(connection.principal, entry.sessionId);
							if (!record || record.taskRef !== entry.taskRef || record.parentSessionId !== undefined) {
								return { sessionId: entry.sessionId, status: "unknown" };
							}
							const snapshot = snapshotOf(record, this.#registry, this.#decisions);
							if (isRetired(record)) return { sessionId: entry.sessionId, status: "completed", snapshot };
							return {
								sessionId: entry.sessionId,
								status: record.turn !== undefined ? "retained_active" : "retained_idle",
								snapshot,
							};
						});
						// Reattach and reply in one synchronous step: the snapshot is queued before any later event
						// for these sessions, and no other connection of the principal keeps receiving them.
						for (const result of sessions) {
							if (result.status === "unknown") continue;
							for (const other of this.#subscribers) if (other !== connection) other.detach(result.sessionId);
							connection.attach(result.sessionId);
						}
						connection.reply(reconciledFrame(id, sessions));
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
						if (isRetired(record)) {
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
						if (isRetired(record)) {
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

	/** Dispose every retained session and clear the retention clocks. Called once at shutdown. */
	async dispose(): Promise<void> {
		this.#retention.dispose();
		await this.#registry.disposeAll();
	}

	#expireIdle(sessionId: string): void {
		const record = this.#registry.find(sessionId);
		if (record && !isRetired(record)) void this.#turns.expireIdle(record);
	}

	#forget(sessionId: string): void {
		const record = this.#registry.find(sessionId);
		if (!record) return;
		for (const childId of record.children) this.#registry.forget(childId);
		this.#registry.forget(sessionId);
	}

	/** The orphan grace ran out: every root session the principal still owns is terminated. */
	#reclaimOrphans(principal: ControlPrincipal): void {
		for (const record of this.#registry.ownedBy(principal)) {
			if (record.parentSessionId !== undefined || isRetired(record)) continue;
			void this.#turns.terminate(record);
		}
	}

	/**
	 * Deliver an event to the subscribed connections of the owning principal that are attached to
	 * its root session. A session whose connection was lost stays detached, and receives no live
	 * events anywhere, until `reconnect` reclaims it and its snapshot is sent (contract section 2.4).
	 */
	#publish(principal: ControlPrincipal, frame: ControlEvent): void {
		const rootId = frame.parentSessionId ?? frame.sessionId;
		for (const connection of this.#subscribers) {
			if (connection.closed) {
				this.#subscribers.delete(connection);
				continue;
			}
			if (connection.principal === principal && connection.subscribed && connection.isAttached(rootId)) {
				connection.reply(frame);
			}
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
		if (isRetired(record)) {
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
		this.#retention.armIdle(sessionId);
		connection.attach(sessionId);
		connection.reply(sessionCreatedFrame(id, sessionId));
	}
}

/** Validate `reconnect.activeSessions`: distinct handles, each with a non-blank id and a UUID task ref. */
function parseReconnectEntries(raw: unknown[]): ReconnectEntry[] {
	const seen = new Set<string>();
	return raw.map((entry, index): ReconnectEntry => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`activeSessions[${index}] must be an object`);
		}
		const { sessionId, taskRef } = entry as Record<string, unknown>;
		if (typeof sessionId !== "string" || !/\S/.test(sessionId)) {
			throw new Error(`activeSessions[${index}].sessionId must be a non-empty string`);
		}
		if (typeof taskRef !== "string" || !UUID_RE.test(taskRef)) {
			throw new Error(`activeSessions[${index}].taskRef must be a UUID`);
		}
		if (seen.has(sessionId)) throw new Error("activeSessions must not repeat a session");
		seen.add(sessionId);
		return { sessionId, taskRef };
	});
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
