/**
 * Turn lifecycle for one control session: accepting an idle prompt (ack, then
 * `session_started`, deadline armed), steering an active turn, and settling the
 * turn to exactly one outcome. Settlement is idempotent; the first outcome wins.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { ControlPrincipal } from "./control-auth";
import type { ControlSessionRecord, ControlTurn, ControlUsageBaseline } from "./control-session-registry";
import type { ControlEvent, ControlUsage } from "./wire/events";

/** Publishes one server event to the subscribed connections of a principal. */
export type ControlPublisher = (principal: ControlPrincipal, frame: ControlEvent) => void;

interface UsageSource {
	getUsageStatistics(): ControlUsageBaseline;
}

function usageBaseline(source: UsageSource): ControlUsageBaseline {
	const stats = source.getUsageStatistics();
	return {
		input: stats.input,
		output: stats.output,
		cacheRead: stats.cacheRead,
		cacheWrite: stats.cacheWrite,
		totalTokens: stats.totalTokens,
	};
}

/**
 * The counters this turn consumed. Omitted entirely when the provider reported
 * no tokens for the turn, so a missing measurement is never shown as zero.
 */
function turnUsage(record: ControlSessionRecord, turn: ControlTurn): ControlUsage | undefined {
	const current = usageBaseline(record.session.sessionManager);
	const previous = turn.usageBaseline;
	const totalTokens = Math.max(0, current.totalTokens - previous.totalTokens);
	if (totalTokens === 0) return undefined;
	return {
		inputTokens: Math.max(0, current.input - previous.input),
		outputTokens: Math.max(0, current.output - previous.output),
		totalTokens,
	};
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}

export class ControlTurnController {
	readonly #publish: ControlPublisher;

	constructor(publish: ControlPublisher) {
		this.#publish = publish;
	}

	/**
	 * Accept an idle prompt: mark the session active, arm the deadline and publish
	 * `session_started`. The caller has already enqueued the `ack`, so the ack precedes the start.
	 */
	start(record: ControlSessionRecord, prompt: string, operatorUserId: string | undefined): void {
		const session = record.session;
		const turn: ControlTurn = {
			operatorUserId,
			usageBaseline: usageBaseline(session.sessionManager),
			assistantBaseline: session.getLastAssistantMessage(),
			stop: undefined,
			settled: false,
			deadline: undefined,
		};
		record.turn = turn;
		record.state = "active";
		turn.deadline = setTimeout(() => this.#expireDeadline(record, turn), record.timeoutMs);
		this.#publish(record.principal, {
			version: 2,
			type: "session_started",
			sessionId: record.sessionId,
			at: Date.now(),
		});
		void this.#run(record, turn, prompt);
	}

	/**
	 * Soft-stop the active turn: abort its generation and tools. The outcome is
	 * published once the run has unwound. A stop already requested (interrupt or
	 * deadline) stands. Returns `false` when there is no active turn.
	 */
	interrupt(record: ControlSessionRecord): boolean {
		const turn = record.turn;
		if (!turn) return false;
		if (turn.stop !== undefined) return true;
		turn.stop = "interrupt";
		record.session.abort({ reason: "control interrupt" }).catch((error: unknown) => {
			logger.warn("control interrupt abort failed", { sessionId: record.sessionId, error: String(error) });
		});
		return true;
	}

	/**
	 * Hard-stop the session. An active turn's only outcome becomes `session_terminated`,
	 * published by its run once it has unwound. An idle session is torn down directly.
	 * The session is disposed before that event, so termination is never announced early.
	 */
	terminate(record: ControlSessionRecord): Promise<void> {
		const turn = record.turn;
		if (!turn) return this.#retire(record, undefined);
		// A hard stop overrides an interrupt or deadline already in progress; the run reports it.
		turn.stop = "terminate";
		record.session.abort({ reason: "control terminate" }).catch((error: unknown) => {
			logger.warn("control terminate abort failed", { sessionId: record.sessionId, error: String(error) });
		});
		return Promise.resolve();
	}

	/** Queue a steering message into the active turn; no new start and no deadline change. */
	async steer(record: ControlSessionRecord, prompt: string): Promise<void> {
		await record.session.steer(prompt);
	}

	async #run(record: ControlSessionRecord, turn: ControlTurn, prompt: string): Promise<void> {
		let runError: unknown;
		try {
			await record.session.prompt(prompt);
			// A steer that was queued before the run began is delivered as a later run of this same turn.
			await waitUntilQuiet(record.session);
		} catch (error) {
			runError = error;
		}
		if (turn.settled) return;
		if (turn.stop === "terminate") {
			await this.#retire(record, turn);
			return;
		}
		if (turn.stop === "interrupt") {
			this.#settleInterrupted(record, turn);
			return;
		}
		const last = record.session.getLastAssistantMessage();
		if (turn.stop === "timeout") {
			this.#settleFailed(record, turn, "timeout", "turn deadline exceeded");
			return;
		}
		if (runError !== undefined) {
			this.#settleFailed(record, turn, "execution_failed", describeError(runError));
			return;
		}
		if (last === undefined || last === turn.assistantBaseline) {
			this.#settleCompleted(record, turn, "");
			return;
		}
		if (last.stopReason === "error") {
			this.#settleFailed(record, turn, "execution_failed", last.errorMessage || "model request failed");
			return;
		}
		if (last.stopReason === "aborted") {
			this.#settleFailed(record, turn, "execution_failed", "turn was aborted");
			return;
		}
		this.#settleCompleted(record, turn, assistantText(last));
	}

	#expireDeadline(record: ControlSessionRecord, turn: ControlTurn): void {
		if (turn.settled || turn.stop !== undefined) return;
		turn.stop = "timeout";
		record.session.abort({ reason: "control turn deadline" }).catch((error: unknown) => {
			logger.warn("control turn abort after deadline failed", { sessionId: record.sessionId, error: String(error) });
		});
	}

	#settleCompleted(record: ControlSessionRecord, turn: ControlTurn, output: string): void {
		this.#settle(record, turn, () => {
			const usage = turnUsage(record, turn);
			return {
				version: 2,
				type: "session_completed",
				sessionId: record.sessionId,
				at: Date.now(),
				output,
				...(usage ? { usage } : {}),
			};
		});
	}

	#settleInterrupted(record: ControlSessionRecord, turn: ControlTurn): void {
		this.#settle(record, turn, () => {
			const usage = turnUsage(record, turn);
			return {
				version: 2,
				type: "session_interrupted",
				sessionId: record.sessionId,
				at: Date.now(),
				...(usage ? { usage } : {}),
			};
		});
	}

	#settleFailed(record: ControlSessionRecord, turn: ControlTurn, code: string, error: string): void {
		this.#settle(record, turn, () => {
			const usage = turnUsage(record, turn);
			return {
				version: 2,
				type: "session_failed",
				sessionId: record.sessionId,
				at: Date.now(),
				code,
				error: error.length > 0 ? error : "unknown error",
				...(usage ? { usage } : {}),
			};
		});
	}

	/**
	 * Dispose the session and retire its handle (a tombstone the daemon keeps, so later
	 * commands answer `unsupported_operation`). `session_terminated` follows the teardown.
	 * When teardown fails, nothing is confirmed: an active turn settles as `teardown_failed`
	 * and the handle stays as it was, so a later terminate can retry.
	 */
	async #retire(record: ControlSessionRecord, turn: ControlTurn | undefined): Promise<void> {
		const usage = turn ? turnUsage(record, turn) : undefined;
		try {
			await record.session.dispose();
		} catch (error) {
			const message = describeError(error);
			logger.error("control session teardown failed", { sessionId: record.sessionId, error: message });
			if (turn) {
				this.#settle(record, turn, () => ({
					version: 2,
					type: "session_failed",
					sessionId: record.sessionId,
					at: Date.now(),
					code: "teardown_failed",
					error: message,
				}));
			}
			return;
		}
		if (turn) {
			this.#settle(record, turn, () => ({
				version: 2,
				type: "session_terminated",
				sessionId: record.sessionId,
				at: Date.now(),
				...(usage ? { usage } : {}),
			}));
		} else {
			this.#publish(record.principal, {
				version: 2,
				type: "session_terminated",
				sessionId: record.sessionId,
				at: Date.now(),
			});
		}
		record.state = "terminated";
	}

	/** Publish the turn's one outcome and return the session to idle. Later calls are ignored. */
	#settle(record: ControlSessionRecord, turn: ControlTurn, build: () => ControlEvent): void {
		if (turn.settled) return;
		turn.settled = true;
		clearTimeout(turn.deadline);
		turn.deadline = undefined;
		if (record.turn === turn) {
			record.turn = undefined;
			record.state = "idle";
		}
		this.#publish(record.principal, build());
	}
}

/** Wait until the session is neither streaming nor holding queued messages. */
async function waitUntilQuiet(session: AgentSession): Promise<void> {
	do {
		await session.waitForIdle();
	} while (session.isStreaming || session.agent.hasQueuedMessages());
}

function describeError(error: unknown): string {
	if (error instanceof Error && error.message.length > 0) return error.message;
	const text = String(error);
	return text.length > 0 ? text : "unknown error";
}
