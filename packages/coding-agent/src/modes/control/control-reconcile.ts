/**
 * Snapshots for `inspect_session` and `reconnect` (contract section 7): a session's
 * lifecycle, its pending decisions, its last settled outcome, and its direct children.
 */
import type { ControlDecisionStore } from "./control-decisions";
import type { ControlSessionRecord, ControlSessionRegistry, ControlSessionState } from "./control-session-registry";
import type { ControlEvent, DecisionRequestedEvent } from "./wire/events";

/** Lifecycle status as the wire reports it. A retired handle is `terminated` or `expired`. */
export type ControlSnapshotStatus = ControlSessionState;

export interface ControlDescendantSnapshot {
	sessionId: string;
	parentSessionId: string;
	status: ControlSnapshotStatus;
	waitingHumanInput: boolean;
	pendingDecisions: DecisionRequestedEvent[];
	lastOutcome?: ControlEvent;
}

export interface ControlSessionSnapshot {
	taskRef: string;
	status: ControlSnapshotStatus;
	parentSessionId?: string;
	waitingHumanInput: boolean;
	pendingDecisions: DecisionRequestedEvent[];
	lastOutcome?: ControlEvent;
	descendants: ControlDescendantSnapshot[];
}

/** One requested handle's reconciliation result, in request order. */
export type ControlReconciliationResult =
	| { sessionId: string; status: "unknown" }
	| { sessionId: string; status: "retained_active" | "retained_idle" | "completed"; snapshot: ControlSessionSnapshot };

/** Lifecycle status of a record, where a turn in progress makes it active. */
export function statusOf(record: ControlSessionRecord): ControlSnapshotStatus {
	if (record.state === "terminated" || record.state === "expired") return record.state;
	return record.turn !== undefined ? "active" : "idle";
}

function describe(
	record: ControlSessionRecord,
	decisions: ControlDecisionStore,
): {
	status: ControlSnapshotStatus;
	waitingHumanInput: boolean;
	pendingDecisions: DecisionRequestedEvent[];
	lastOutcome?: ControlEvent;
} {
	const pending = decisions.pendingFor(record.sessionId);
	const pendingDecisions = pending ? [pending] : [];
	const status = statusOf(record);
	return {
		status,
		waitingHumanInput: pendingDecisions.length > 0,
		pendingDecisions,
		// An active turn has no outcome yet; the previous turn's would read as this turn's.
		...(record.lastOutcome !== undefined && status !== "active" ? { lastOutcome: record.lastOutcome } : {}),
	};
}

/** Every descendant of `record`, depth-first pre-order, so each parent precedes its children. */
function collectDescendants(
	record: ControlSessionRecord,
	registry: ControlSessionRegistry,
	decisions: ControlDecisionStore,
	into: ControlDescendantSnapshot[],
): void {
	for (const childId of record.children) {
		const child = registry.find(childId);
		if (!child || child.parentSessionId === undefined) continue;
		const childState = describe(child, decisions);
		into.push({ sessionId: child.sessionId, parentSessionId: child.parentSessionId, ...childState });
		collectDescendants(child, registry, decisions, into);
	}
}

/** Snapshot of one session and every descendant, parent before child (depth-first pre-order). */
export function snapshotOf(
	record: ControlSessionRecord,
	registry: ControlSessionRegistry,
	decisions: ControlDecisionStore,
): ControlSessionSnapshot {
	const own = describe(record, decisions);
	const descendants: ControlDescendantSnapshot[] = [];
	collectDescendants(record, registry, decisions, descendants);
	return {
		taskRef: record.taskRef,
		...own,
		...(record.parentSessionId !== undefined ? { parentSessionId: record.parentSessionId } : {}),
		descendants,
	};
}
