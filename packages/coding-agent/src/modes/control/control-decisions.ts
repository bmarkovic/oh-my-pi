/**
 * Decision store: a session's pending human question, its answer, and the
 * outcome that releases the asking continuation. One question is pending per
 * session. An answer is accepted once; an identical retry is acknowledged without
 * a second event; anything else about a settled decision is `invalid_decision_state`.
 * Interrupt, terminate and the turn deadline invalidate the pending question.
 */
import type { ControlPrincipal } from "./control-auth";
import type { ControlPublisher } from "./control-turn";
import { CONTROL_MAX_MESSAGE_BYTES } from "./wire/envelope";
import { elideDecisionRequested, frameBytes } from "./wire/elision";
import type { DecisionOption, DecisionRequestedEvent } from "./wire/events";

/** A question as the asking tool poses it. Options are labels; the store assigns their ids. */
export interface DecisionRequest {
	/** Set when the question comes from a child session: the handle of the session that spawned it. */
	parentSessionId?: string;
	question: string;
	options: ReadonlyArray<{ label: string; description?: string }>;
	allowFreeText: boolean;
	signal?: AbortSignal;
}

/** The human's answer: one option, or free text when the question allowed it. */
export type DecisionAnswer = { optionId: string } | { text: string };

export interface DecisionAnswerCommand {
	decisionId: string;
	optionId?: string;
	text?: string;
	answeringUserId?: string;
}

/** Outcome of `answer_decision`. `accepted` must be followed by {@link ControlDecisionStore.release}. */
export type DecisionAnswerResult =
	| { kind: "accepted"; decisionId: string }
	| { kind: "duplicate" }
	| { kind: "rejected"; code: "invalid_message" | "invalid_decision_state"; message: string };

interface DecisionEntry {
	readonly decisionId: string;
	readonly sessionId: string;
	readonly principal: ControlPrincipal;
	readonly options: readonly DecisionOption[];
	readonly allowFreeText: boolean;
	state: "pending" | "answered" | "invalidated";
	answer: DecisionAnswer | undefined;
	answeringUserId: string | undefined;
	readonly resolve: (answer: DecisionAnswer | undefined) => void;
	readonly question: string;
	readonly elided: string[] | undefined;
	readonly parentSessionId: string | undefined;
	readonly requestedAt: number;
}

/** Validate the answer's form against the question: exactly one of an option id or text. */
function formProblem(entry: DecisionEntry, command: DecisionAnswerCommand): string | undefined {
	const hasOption = command.optionId !== undefined;
	const hasText = command.text !== undefined;
	if (hasOption === hasText) return "answer must carry exactly one of optionId or text";
	if (hasOption && !entry.options.some(option => option.optionId === command.optionId)) {
		return "optionId is not an option of this decision";
	}
	if (hasText && !entry.allowFreeText) return "this decision does not accept free text";
	return undefined;
}

function sameAnswer(answer: DecisionAnswer | undefined, command: DecisionAnswerCommand): boolean {
	if (answer === undefined) return false;
	if ("optionId" in answer) return command.optionId === answer.optionId && command.text === undefined;
	return command.text === answer.text && command.optionId === undefined;
}

export class ControlDecisionStore {
	readonly #publish: ControlPublisher;
	readonly #entries = new Map<string, DecisionEntry>();
	/** The one pending decision of each session. */
	readonly #pendingBySession = new Map<string, string>();
	readonly #retentionMs: number;

	/**
	 * @param retentionMs how long a settled decision stays answerable for identical retries;
	 *   beyond it the id is unknown.
	 */
	constructor(publish: ControlPublisher, retentionMs: number) {
		this.#publish = publish;
		this.#retentionMs = retentionMs;
	}

	/** The pending decision of `sessionId`, as its `decision_requested` event, if one waits. */
	pendingFor(sessionId: string): DecisionRequestedEvent | undefined {
		const decisionId = this.#pendingBySession.get(sessionId);
		const entry = decisionId === undefined ? undefined : this.#entries.get(decisionId);
		if (!entry || entry.state !== "pending") return undefined;
		return {
			version: 2,
			type: "decision_requested",
			sessionId,
			at: entry.requestedAt,
			decisionId: entry.decisionId,
			question: entry.question,
			options: [...entry.options],
			allowFreeText: entry.allowFreeText,
			...(entry.elided !== undefined ? { elided: entry.elided } : {}),
			...(entry.parentSessionId !== undefined ? { parentSessionId: entry.parentSessionId } : {}),
		};
	}

	/**
	 * Ask a human. Publishes `decision_requested` and resolves with the answer, or with
	 * `undefined` when the question is invalidated (abort, interrupt, terminate, deadline).
	 * A second question while one is pending resolves `undefined` at once.
	 */
	request(
		sessionId: string,
		principal: ControlPrincipal,
		request: DecisionRequest,
	): Promise<DecisionAnswer | undefined> {
		if (this.#pendingBySession.has(sessionId)) return Promise.resolve(undefined);
		const decisionId = crypto.randomUUID();
		const options: DecisionOption[] = request.options.map((option, index) => ({
			optionId: String(index),
			label: option.label,
			...(option.description !== undefined ? { description: option.description } : {}),
		}));
		// The stored question is the delivered one, so a snapshot shows what the client was sent.
		const delivered = elideDecisionRequested(
			{
				version: 2,
				type: "decision_requested",
				sessionId,
				at: Date.now(),
				decisionId,
				question: request.question,
				options,
				allowFreeText: request.allowFreeText,
				...(request.parentSessionId !== undefined ? { parentSessionId: request.parentSessionId } : {}),
			},
			CONTROL_MAX_MESSAGE_BYTES,
		);
		// A decision that cannot fit a frame even with its labels cut to one code point is not asked: the tool
		// gets the same refusal as an unsupported question, so the turn continues without an unanswerable decision.
		if (frameBytes(delivered) > CONTROL_MAX_MESSAGE_BYTES) {
			return Promise.reject(new Error("decision is too large for a control frame"));
		}
		const { promise, resolve } = Promise.withResolvers<DecisionAnswer | undefined>();
		const entry: DecisionEntry = {
			decisionId,
			sessionId,
			principal,
			options: delivered.options,
			allowFreeText: request.allowFreeText,
			state: "pending",
			answer: undefined,
			answeringUserId: undefined,
			resolve,
			question: delivered.question,
			elided: delivered.elided,
			parentSessionId: request.parentSessionId,
			requestedAt: delivered.at,
		};
		this.#entries.set(decisionId, entry);
		this.#pendingBySession.set(sessionId, decisionId);
		this.#publish(principal, delivered);
		const signal = request.signal;
		if (signal?.aborted) this.#invalidate(entry);
		else signal?.addEventListener("abort", () => this.#invalidate(entry), { once: true });
		return promise;
	}

	/** Validate and record an answer. The caller acknowledges, then calls {@link release} when accepted. */
	answer(principal: ControlPrincipal, command: DecisionAnswerCommand): DecisionAnswerResult {
		const entry = this.#entries.get(command.decisionId);
		if (!entry || entry.principal !== principal) {
			return { kind: "rejected", code: "invalid_decision_state", message: "decision is not pending" };
		}
		if (entry.state === "pending") {
			const problem = formProblem(entry, command);
			if (problem !== undefined) return { kind: "rejected", code: "invalid_message", message: problem };
			entry.state = "answered";
			this.#forgetAfterRetention(entry.decisionId);
			entry.answer = command.optionId !== undefined ? { optionId: command.optionId } : { text: command.text ?? "" };
			entry.answeringUserId = command.answeringUserId;
			this.#pendingBySession.delete(entry.sessionId);
			return { kind: "accepted", decisionId: entry.decisionId };
		}
		if (entry.state === "answered" && sameAnswer(entry.answer, command)) return { kind: "duplicate" };
		return { kind: "rejected", code: "invalid_decision_state", message: "decision is not pending" };
	}

	/** Publish `decision_answered` for an accepted answer, then release the asking continuation. */
	release(decisionId: string): void {
		const entry = this.#entries.get(decisionId);
		if (!entry || entry.state !== "answered" || entry.answer === undefined) return;
		const answer = entry.answer;
		this.#publish(entry.principal, {
			version: 2,
			type: "decision_answered",
			sessionId: entry.sessionId,
			...(entry.parentSessionId !== undefined ? { parentSessionId: entry.parentSessionId } : {}),
			at: Date.now(),
			decisionId,
			...("optionId" in answer ? { optionId: answer.optionId } : { text: answer.text }),
			...(entry.answeringUserId !== undefined ? { answeringUserId: entry.answeringUserId } : {}),
		});
		entry.resolve(answer);
	}

	/** Invalidate the session's pending question, if any. Idempotent. */
	invalidateSession(sessionId: string): void {
		const decisionId = this.#pendingBySession.get(sessionId);
		if (decisionId === undefined) return;
		const entry = this.#entries.get(decisionId);
		if (entry) this.#invalidate(entry);
	}

	#invalidate(entry: DecisionEntry): void {
		if (entry.state !== "pending") return;
		entry.state = "invalidated";
		this.#pendingBySession.delete(entry.sessionId);
		this.#forgetAfterRetention(entry.decisionId);
		entry.resolve(undefined);
	}

	/** A settled decision answers identical retries for the retention window, then its id is unknown. */
	#forgetAfterRetention(decisionId: string): void {
		const timer = setTimeout(() => this.#entries.delete(decisionId), this.#retentionMs);
		timer.unref();
	}
}
