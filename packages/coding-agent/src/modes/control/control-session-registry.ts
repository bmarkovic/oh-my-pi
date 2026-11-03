/**
 * Handle registry. A handle is an opaque UUID owned by the control principal that
 * created it; another principal's lookup returns `undefined`, which callers report
 * as `unknown_session`, so existence is never disclosed across principals.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { ControlPrincipal } from "./control-auth";
import type { ControlToolBinding } from "./control-endpoint-tool";
import type { ControlEvent } from "./wire/events";

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
	stop: "interrupt" | "timeout" | "terminate" | undefined;
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
	/** Tool bindings currently installed on the session (empty when none). */
	tools: ControlToolBinding[];
	/** Serializes prompt commands on this session, so a tool replacement never races a turn start. */
	lane: Promise<void>;
	/** The session that spawned this one; `undefined` for a root session. */
	readonly parentSessionId?: string;
	/** Set while the handle is being torn down (terminate or idle expiry), so a second teardown or a prompt cannot race it. */
	retirement?: Promise<void>;
	/** The last settled outcome or retirement event, reported by `inspect_session` and `reconnect`. */
	lastOutcome?: ControlEvent;
	/** Direct children, in creation order, including settled ones. */
	readonly children: string[];
}

export class ControlSessionRegistry {
	readonly #records = new Map<string, ControlSessionRecord>();

	register(record: ControlSessionRecord): void {
		this.#records.set(record.sessionId, record);
	}

	/** The record for `sessionId` regardless of owner. For daemon-internal use only, never for a reply. */
	find(sessionId: string): ControlSessionRecord | undefined {
		return this.#records.get(sessionId);
	}

	/** The record when `principal` owns `sessionId`; otherwise `undefined`. */
	lookup(principal: ControlPrincipal, sessionId: string): ControlSessionRecord | undefined {
		const record = this.#records.get(sessionId);
		if (!record || record.principal !== principal) return undefined;
		return record;
	}

	/** Every record `principal` owns, root and child alike, in creation order. */
	ownedBy(principal: ControlPrincipal): ControlSessionRecord[] {
		return [...this.#records.values()].filter(record => record.principal === principal);
	}

	/** Forget a retired handle entirely: later lookups answer `unknown_session`. */
	forget(sessionId: string): void {
		this.#records.delete(sessionId);
	}

	/** Every record, root and child alike. */
	all(): ControlSessionRecord[] {
		return [...this.#records.values()];
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
