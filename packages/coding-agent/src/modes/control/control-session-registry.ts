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

export interface ControlSessionRecord {
	readonly sessionId: string;
	readonly principal: ControlPrincipal;
	readonly taskRef: string;
	readonly timeoutMs: number;
	state: ControlSessionState;
	readonly session: AgentSession;
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
