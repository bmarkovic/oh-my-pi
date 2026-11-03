/**
 * Handle registry. A handle is an opaque UUID owned by the control principal that
 * created it; another principal's lookup returns `undefined`, which callers report
 * as `unknown_session`, so existence is never disclosed across principals.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { ControlPrincipal } from "./control-auth";

/** Lifecycle state of a retained handle (contract section 5). */
export type ControlSessionState = "idle" | "active" | "terminated" | "expired";

/** Counters read from the session manager when a turn starts; usage is the delta from these. */
export interface ControlUsageBaseline {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

/** One accepted turn until its single settled outcome. */
export interface ControlTurn {
	readonly operatorUserId: string | undefined;
	readonly usageBaseline: ControlUsageBaseline;
	/** The last assistant message when the turn started; a different one at the end means the turn produced output. */
	readonly assistantBaseline: unknown;
	/** The first stop request on this turn: an interrupt or the deadline. It decides the outcome. */
	stop: "interrupt" | "timeout" | undefined;
	/** Set once the turn's outcome has been published. */
	settled: boolean;
	deadline: Timer | undefined;
}

export interface ControlSessionRecord {
	readonly sessionId: string;
	readonly principal: ControlPrincipal;
	readonly taskRef: string;
	readonly timeoutMs: number;
	state: ControlSessionState;
	readonly session: AgentSession;
	/** Present while a turn is accepted and unsettled. */
	turn?: ControlTurn;
}

export class ControlSessionRegistry {
	readonly #records = new Map<string, ControlSessionRecord>();

	register(record: ControlSessionRecord): void {
		this.#records.set(record.sessionId, record);
	}

	/** The record when `principal` owns `sessionId`; otherwise `undefined`. */
	lookup(principal: ControlPrincipal, sessionId: string): ControlSessionRecord | undefined {
		const record = this.#records.get(sessionId);
		if (!record || record.principal !== principal) return undefined;
		return record;
	}

	/** Dispose every retained session. Every dispose settles even when another one fails. */
	async disposeAll(): Promise<void> {
		const records = [...this.#records.values()];
		this.#records.clear();
		const results = await Promise.allSettled(records.map(record => record.session.dispose()));
		for (const result of results) {
			if (result.status === "rejected")
				logger.warn("control session dispose failed", { error: String(result.reason) });
		}
	}
}
