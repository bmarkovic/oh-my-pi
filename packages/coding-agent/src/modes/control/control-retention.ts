/**
 * Retention clocks for control sessions. Idle reuse expires after a quiet period,
 * retired handles are forgotten after a retention window, and a principal's sessions
 * are reclaimed when its last connection has been gone for the orphan grace period.
 * Timers never keep the process alive, and a session that is active or waiting on a
 * human is never armed as idle.
 */
import type { ControlPrincipal } from "./control-auth";

/** Durations in milliseconds (contract section 2.2 and the shared wire profile). */
export interface ControlRetentionTiming {
	idleTtlMs: number;
	tombstoneRetentionMs: number;
	orphanGraceMs: number;
}

export const DEFAULT_RETENTION_TIMING: ControlRetentionTiming = {
	idleTtlMs: 600_000,
	tombstoneRetentionMs: 60_000,
	orphanGraceMs: 60_000,
};

export interface ControlRetentionCallbacks {
	/** The session has been idle for `idleTtlMs`. */
	expireIdle(sessionId: string): void;
	/** A retired handle outlived its retention window. */
	forget(sessionId: string): void;
	/** A principal has had no connection for the orphan grace period. */
	reclaimOrphans(principal: ControlPrincipal): void;
}

export class ControlRetention {
	readonly #timing: ControlRetentionTiming;
	readonly #callbacks: ControlRetentionCallbacks;
	readonly #idle = new Map<string, Timer>();
	readonly #tombstones = new Map<string, Timer>();
	readonly #orphans = new Map<ControlPrincipal, Timer>();

	constructor(timing: ControlRetentionTiming, callbacks: ControlRetentionCallbacks) {
		this.#timing = timing;
		this.#callbacks = callbacks;
	}

	/** Restart the idle clock for a session that has just become idle. */
	armIdle(sessionId: string): void {
		this.cancelIdle(sessionId);
		this.#idle.set(
			sessionId,
			this.#timer(
				() => this.#idle.delete(sessionId) && this.#callbacks.expireIdle(sessionId),
				this.#timing.idleTtlMs,
			),
		);
	}

	cancelIdle(sessionId: string): void {
		clearTimeout(this.#idle.get(sessionId));
		this.#idle.delete(sessionId);
	}

	/** Start the retention window of a retired handle. */
	armForget(sessionId: string): void {
		if (this.#tombstones.has(sessionId)) return;
		this.#tombstones.set(
			sessionId,
			this.#timer(
				() => this.#tombstones.delete(sessionId) && this.#callbacks.forget(sessionId),
				this.#timing.tombstoneRetentionMs,
			),
		);
	}

	/** A principal lost its last connection: its sessions are reclaimed unless it reconnects in time. */
	armOrphanGrace(principal: ControlPrincipal): void {
		this.cancelOrphanGrace(principal);
		this.#orphans.set(
			principal,
			this.#timer(
				() => this.#orphans.delete(principal) && this.#callbacks.reclaimOrphans(principal),
				this.#timing.orphanGraceMs,
			),
		);
	}

	cancelOrphanGrace(principal: ControlPrincipal): void {
		clearTimeout(this.#orphans.get(principal));
		this.#orphans.delete(principal);
	}

	/** Clear every timer. Called at shutdown. */
	dispose(): void {
		for (const timer of [...this.#idle.values(), ...this.#tombstones.values(), ...this.#orphans.values()])
			clearTimeout(timer);
		this.#idle.clear();
		this.#tombstones.clear();
		this.#orphans.clear();
	}

	#timer(fire: () => unknown, delayMs: number): Timer {
		const timer = setTimeout(fire, delayMs);
		timer.unref();
		return timer;
	}
}
