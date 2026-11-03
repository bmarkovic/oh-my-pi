/**
 * Child lineage. A subagent a root control session spawns becomes a child handle
 * when its session is built: its `session_started` carries the parent's handle,
 * and each run it makes settles once as a child-scoped outcome. Interrupt and
 * terminate cascade to the children, whose terminal events precede the parent's.
 * Only direct children of a root are tracked; deeper descendants are disposed with
 * their owning child.
 */
import type { AgentSession } from "../../session/agent-session";
import { logger } from "@oh-my-pi/pi-utils";
import type { ControlPublisher } from "./control-turn";
import { assistantText, turnUsage, waitUntilQuiet } from "./control-turn";
import type { ControlDecisionStore } from "./control-decisions";
import type {
	ControlSessionRecord,
	ControlSessionRegistry,
	ControlTurn,
	ControlUsageBaseline,
} from "./control-session-registry";
import type { ControlEvent, ControlUsage } from "./wire/events";

function usageBaseline(session: AgentSession): ControlUsageBaseline {
	const stats = session.sessionManager.getUsageStatistics();
	return {
		input: stats.input,
		output: stats.output,
		cacheRead: stats.cacheRead,
		cacheWrite: stats.cacheWrite,
		totalTokens: stats.totalTokens,
	};
}

export interface ControlChildLedgerOptions {
	publish: ControlPublisher;
	decisions: ControlDecisionStore;
	registry: ControlSessionRegistry;
}

export class ControlChildLedger {
	readonly #publish: ControlPublisher;
	readonly #decisions: ControlDecisionStore;
	readonly #registry: ControlSessionRegistry;
	readonly #unsubscribers = new Map<string, () => void>();

	constructor(options: ControlChildLedgerOptions) {
		this.#publish = options.publish;
		this.#decisions = options.decisions;
		this.#registry = options.registry;
	}

	/**
	 * Register a freshly built child of `parent` and start its first turn, so its
	 * `session_started` is published before any of its own activity.
	 */
	adopt(parent: ControlSessionRecord, session: AgentSession, sessionId: string): ControlSessionRecord {
		const child: ControlSessionRecord = {
			sessionId,
			principal: parent.principal,
			taskRef: parent.taskRef,
			timeoutMs: parent.timeoutMs,
			state: "active",
			session,
			tools: parent.tools,
			lane: Promise.resolve(),
			parentSessionId: parent.sessionId,
			children: [],
		};
		this.#registry.register(child);
		parent.children.push(sessionId);
		this.#startTurn(child);
		this.#unsubscribers.set(
			sessionId,
			session.subscribe(event => {
				if (event.type === "agent_start") {
					if (child.turn === undefined && child.state !== "terminated") this.#startTurn(child);
				} else if (event.type === "agent_end" && event.isTerminal !== false) {
					this.#settleWhenQuiet(child);
				}
			}),
		);
		return child;
	}

	/** Abort every active child run. Each settles as `session_interrupted` once it has unwound. */
	interruptChildren(parent: ControlSessionRecord): void {
		for (const childId of parent.children) {
			const child = this.#registry.find(childId);
			const turn = child?.turn;
			if (!child || !turn || turn.stop !== undefined) continue;
			turn.stop = "interrupt";
			this.#decisions.invalidateSession(child.sessionId);
			// The run may end without a terminal `agent_end` reaching this listener, so settle once the session is quiet.
			child.session
				.abort({ reason: "control interrupt" })
				.then(() => this.#settleWhenQuiet(child))
				.catch((error: unknown) => {
					logger.warn("control child interrupt failed", { sessionId: child.sessionId, error: String(error) });
				});
		}
	}

	/** Wait for every child run still in progress to unwind, and publish each child's outcome. */
	async settleChildren(parent: ControlSessionRecord): Promise<void> {
		for (const childId of parent.children) {
			const child = this.#registry.find(childId);
			const turn = child?.turn;
			if (!child || !turn) continue;
			await waitUntilQuiet(child.session);
			if (child.turn === turn && child.state !== "terminated") this.#settle(child, turn);
		}
	}

	/**
	 * Hard-stop every child, in creation order: abort active runs, dispose each session,
	 * and publish `session_terminated` for it. Settles before the parent's own teardown.
	 */
	async terminateChildren(parent: ControlSessionRecord): Promise<void> {
		for (const childId of parent.children) {
			const child = this.#registry.find(childId);
			if (!child || child.state === "terminated") continue;
			const turn = child.turn;
			if (turn) turn.stop = "terminate";
			this.#decisions.invalidateSession(child.sessionId);
			this.#unsubscribers.get(child.sessionId)?.();
			this.#unsubscribers.delete(child.sessionId);
			await child.session.abort({ reason: "control terminate" }).catch(() => undefined);
			try {
				await child.session.dispose();
			} catch (error) {
				logger.error("control child teardown failed", { sessionId: child.sessionId, error: String(error) });
				continue;
			}
			child.turn = undefined;
			child.state = "terminated";
			const usage = turn ? turnUsage(child, turn) : undefined;
			this.#outcome(child, {
				version: 2,
				type: "session_terminated",
				sessionId: child.sessionId,
				parentSessionId: parent.sessionId,
				at: Date.now(),
				...(usage ? { usage } : {}),
			});
		}
	}

	/** Publish a settled outcome and keep it as the child's last outcome. */
	#outcome(child: ControlSessionRecord, event: ControlEvent): void {
		child.lastOutcome = event;
		this.#publish(child.principal, event);
	}

	/**
	 * Expire the idle children of an idle parent that is being expired. A child with
	 * a turn in progress is left alone; the parent cannot be idle while one runs.
	 */
	async expireChildren(parent: ControlSessionRecord): Promise<void> {
		for (const childId of parent.children) {
			const child = this.#registry.find(childId);
			if (!child || child.state !== "idle" || child.turn !== undefined) continue;
			this.#unsubscribers.get(child.sessionId)?.();
			this.#unsubscribers.delete(child.sessionId);
			try {
				await child.session.dispose();
			} catch (error) {
				logger.error("control child expiry failed", { sessionId: child.sessionId, error: String(error) });
				continue;
			}
			child.state = "expired";
			this.#outcome(child, {
				version: 2,
				type: "session_expired",
				sessionId: child.sessionId,
				parentSessionId: parent.sessionId,
				at: Date.now(),
				reason: "idle_ttl",
			});
		}
	}

	#startTurn(child: ControlSessionRecord): void {
		const turn: ControlTurn = {
			operatorUserId: undefined,
			usageBaseline: usageBaseline(child.session),
			assistantBaseline: child.session.getLastAssistantMessage(),
			stop: undefined,
			settled: false,
			deadline: undefined,
		};
		child.turn = turn;
		child.state = "active";
		this.#publish(child.principal, {
			version: 2,
			type: "session_started",
			sessionId: child.sessionId,
			parentSessionId: child.parentSessionId,
			at: Date.now(),
		});
	}

	#parentTerminating(child: ControlSessionRecord): boolean {
		const parent = child.parentSessionId === undefined ? undefined : this.#registry.find(child.parentSessionId);
		return parent?.turn?.stop === "terminate" || parent?.retirement !== undefined;
	}

	#settleWhenQuiet(child: ControlSessionRecord): void {
		const turn = child.turn;
		if (!turn) return;
		void waitUntilQuiet(child.session).then(() => {
			if (child.turn === turn && child.state !== "terminated") this.#settle(child, turn);
		});
	}

	#settle(child: ControlSessionRecord, turn: ControlTurn): void {
		if (turn.settled) return;
		// A hard stop of the parent aborts its running children, and their aborted run reports before the
		// parent has unwound. The child's one outcome is the session_terminated that terminateChildren
		// publishes (contract section 4.4), not a failure for the abort that stop caused.
		if (this.#parentTerminating(child)) return;
		turn.settled = true;
		child.turn = undefined;
		child.state = "idle";
		this.#decisions.invalidateSession(child.sessionId);
		const usage: ControlUsage | undefined = turnUsage(child, turn);
		const base = {
			version: 2 as const,
			sessionId: child.sessionId,
			parentSessionId: child.parentSessionId,
			at: Date.now(),
		};
		if (turn.stop === "interrupt") {
			this.#outcome(child, { ...base, type: "session_interrupted", ...(usage ? { usage } : {}) });
			return;
		}
		const last = child.session.getLastAssistantMessage();
		if (last === undefined || last === turn.assistantBaseline) {
			this.#outcome(child, {
				...base,
				type: "session_completed",
				output: "",
				...(usage ? { usage } : {}),
			});
			return;
		}
		if (last.stopReason === "error" || last.stopReason === "aborted") {
			const error =
				last.errorMessage || (last.stopReason === "aborted" ? "turn was aborted" : "model request failed");
			this.#outcome(child, {
				...base,
				type: "session_failed",
				code: "execution_failed",
				error,
				...(usage ? { usage } : {}),
			});
			return;
		}
		this.#outcome(child, {
			...base,
			type: "session_completed",
			output: assistantText(last),
			...(usage ? { usage } : {}),
		});
	}
}
