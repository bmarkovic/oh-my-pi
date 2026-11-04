/**
 * Server events (contract section 4.6). Every event carries `version`, `sessionId`
 * and `at` (epoch milliseconds, informational); child events add `parentSessionId`.
 */
import type { CONTROL_PROTOCOL_VERSION } from "./envelope";

/** Counters for one session's own turn. An omitted field was not measured, never zero. */
export interface ControlUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

interface ControlEventBase<T extends string> {
	version: typeof CONTROL_PROTOCOL_VERSION;
	type: T;
	sessionId: string;
	parentSessionId?: string;
	at: number;
	/** JSON Pointers of the fields cut to fit the message limit. Absent when nothing was cut. */
	elided?: string[];
}

export type SessionStartedEvent = ControlEventBase<"session_started">;

export interface SessionCompletedEvent extends ControlEventBase<"session_completed"> {
	output: string;
	usage?: ControlUsage;
}

export interface SessionFailedEvent extends ControlEventBase<"session_failed"> {
	code: string;
	error: string;
	usage?: ControlUsage;
}

export interface SessionInterruptedEvent extends ControlEventBase<"session_interrupted"> {
	usage?: ControlUsage;
}

export interface SessionTerminatedEvent extends ControlEventBase<"session_terminated"> {
	usage?: ControlUsage;
}

export interface SessionExpiredEvent extends ControlEventBase<"session_expired"> {
	reason: "idle_ttl";
}

export interface DecisionOption {
	optionId: string;
	label: string;
	description?: string;
}

export interface DecisionRequestedEvent extends ControlEventBase<"decision_requested"> {
	decisionId: string;
	question: string;
	options: DecisionOption[];
	allowFreeText: boolean;
	context?: Record<string, unknown>;
}

export interface DecisionAnsweredEvent extends ControlEventBase<"decision_answered"> {
	decisionId: string;
	optionId?: string;
	text?: string;
	answeringUserId?: string;
}

/** Every server event the daemon can emit. */
export type ControlEvent =
	| SessionStartedEvent
	| SessionCompletedEvent
	| SessionFailedEvent
	| SessionInterruptedEvent
	| SessionTerminatedEvent
	| SessionExpiredEvent
	| DecisionRequestedEvent
	| DecisionAnsweredEvent;
