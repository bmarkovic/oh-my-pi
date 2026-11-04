/**
 * Oversize elision for server frames. A frame whose UTF-8 size exceeds the message limit
 * has its text fields cut until it fits; frames within the limit are never changed. Cuts
 * are recorded as RFC 6901 JSON Pointers in an additive `elided` list on the event, so a
 * client knows which fields were shortened. The producer applies these functions, so the
 * delivered event and the stored one (the last outcome, a pending decision) agree.
 */
import type { ControlReconciliationResult, ControlSessionSnapshot } from "../control-reconcile";
import { CONTROL_MAX_MESSAGE_BYTES } from "./envelope";
import type { ControlEvent, DecisionRequestedEvent } from "./events";

/** Size of an embedded event inside a reply that is itself over the limit (embedded events in replies, contract section 7). */
export const EMBEDDED_EVENT_LIMIT_BYTES = 4_096;

/** UTF-8 size of a value's serialized JSON. */
export function frameBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

/** `value` cut before UTF-16 index `end`, backing off one unit when that would split a surrogate pair. */
function boundaryPrefix(value: string, end: number): string {
	const cut = end > 0 && isHighSurrogate(value.charCodeAt(end - 1)) ? end - 1 : end;
	return value.slice(0, cut);
}

/**
 * The longest prefix of `value` for which `fits` holds, cut on a code point boundary. `fits`
 * must hold for shorter prefixes whenever it holds for longer ones (serialized size grows
 * monotonically with the prefix). Returns `""` when not even the empty prefix fits.
 */
export function longestFittingPrefix(value: string, fits: (candidate: string) => boolean): string {
	if (fits(value)) return value;
	let low = 0;
	let high = value.length;
	// Invariant: the prefix at `low` fits (or is empty) and the prefix at `high` does not.
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(boundaryPrefix(value, mid))) low = mid;
		else high = mid - 1;
	}
	return boundaryPrefix(value, low);
}

/** Elide one event so that its serialized frame fits `limit`. Frames that already fit are returned as they are. */
export function elideEvent(event: ControlEvent, limit: number = CONTROL_MAX_MESSAGE_BYTES): ControlEvent {
	if (frameBytes(event) <= limit) return event;
	switch (event.type) {
		case "session_completed": {
			const marks = pointersWith(event.elided, "/output");
			const output = longestFittingPrefix(
				event.output,
				candidate => frameBytes({ ...event, output: candidate, elided: marks }) <= limit,
			);
			return { ...event, output, elided: marks };
		}
		case "session_failed": {
			const marks = pointersWith(event.elided, "/error");
			const error = longestFittingPrefix(
				event.error,
				candidate => frameBytes({ ...event, error: candidate, elided: marks }) <= limit,
			);
			return { ...event, error, elided: marks };
		}
		case "decision_answered": {
			if (event.text === undefined) return event;
			const marks = pointersWith(event.elided, "/text");
			const text = longestFittingPrefix(
				event.text,
				candidate => frameBytes({ ...event, text: candidate, elided: marks }) <= limit,
			);
			return { ...event, text, elided: marks };
		}
		case "decision_requested":
			return elideDecisionRequested(event, limit);
		default:
			// Fixed small fields only: nothing here is elidable, so the frame is left as it is.
			return event;
	}
}

/** `existing` plus one pointer, in the order the cuts were made. */
function pointersWith(existing: string[] | undefined, pointer: string): string[] {
	return [...(existing ?? []), pointer];
}

/**
 * Elide a `decision_requested` in the order the contract gives: drop `context` entirely, then cut
 * `question`, then cut every option label to an equal byte share (never less than its first code
 * point). Ids, option ids and the option count are never touched. Every size check counts the
 * `elided` list as it would be written. The result may still exceed the limit when the option count
 * is extreme; the caller must then refuse to publish the decision.
 */
export function elideDecisionRequested(event: DecisionRequestedEvent, limit: number): DecisionRequestedEvent {
	if (frameBytes(event) <= limit) return event;
	const pointers: string[] = [];
	const withPointers = (candidate: DecisionRequestedEvent, marks: string[]): DecisionRequestedEvent =>
		marks.length > 0 ? { ...candidate, elided: marks } : candidate;

	let working = event;
	if (working.context !== undefined) {
		const { context: _dropped, ...withoutContext } = working;
		working = withoutContext;
		pointers.push("/context");
		if (frameBytes(withPointers(working, pointers)) <= limit) return withPointers(working, pointers);
	}

	const base = working;
	const questionMarks = [...pointers, "/question"];
	const question = longestFittingPrefix(
		base.question,
		candidate => frameBytes(withPointers({ ...base, question: candidate }, questionMarks)) <= limit,
	);
	if (question !== base.question) pointers.push("/question");
	working = { ...base, question };
	if (frameBytes(withPointers(working, pointers)) <= limit) return withPointers(working, pointers);

	const labelBase = working;
	const emptyLabels = labelBase.options.map(option => ({ ...option, label: "" }));
	const labelMarks = [...pointers, ...labelBase.options.map((_option, index) => `/options/${index}/label`)];
	const slack = limit - frameBytes(withPointers({ ...labelBase, options: emptyLabels }, labelMarks));
	const share = labelBase.options.length === 0 ? 0 : Math.floor(slack / labelBase.options.length);
	const options = labelBase.options.map((option, index) => {
		const firstCodePoint = option.label.length === 0 ? "" : String.fromCodePoint(option.label.codePointAt(0) ?? 0);
		const budget = Math.max(share, frameBytes(firstCodePoint));
		const label = longestFittingPrefix(option.label, candidate => frameBytes(candidate) <= budget);
		if (label !== option.label) pointers.push(`/options/${index}/label`);
		return { ...option, label };
	});
	return withPointers({ ...labelBase, options }, pointers);
}

/** Embedded events of one snapshot, cut in the order the contract gives: descendants last to first, then the root. */
function embeddedCuts(snapshot: ControlSessionSnapshot): Array<() => void> {
	const cuts: Array<() => void> = [];
	const holdersFirst = [...snapshot.descendants].reverse();
	for (const holder of [...holdersFirst, snapshot]) {
		if (holder.lastOutcome !== undefined) {
			cuts.push(() => {
				if (holder.lastOutcome !== undefined) {
					holder.lastOutcome = elideEvent(holder.lastOutcome, EMBEDDED_EVENT_LIMIT_BYTES);
				}
			});
		}
		holder.pendingDecisions.forEach((decision, index) => {
			cuts.push(() => {
				holder.pendingDecisions[index] = elideDecisionRequested(decision, EMBEDDED_EVENT_LIMIT_BYTES);
			});
		});
	}
	return cuts;
}

/**
 * Cut the events embedded in a reply until `fits` reports that the reply fits. The snapshots must be
 * copies owned by the caller: they are changed in place. Records (ids, statuses, counts) are not changed.
 */
export function cutEmbeddedEvents(snapshots: readonly ControlSessionSnapshot[], fits: () => boolean): void {
	if (fits()) return;
	for (const snapshot of snapshots) {
		for (const cut of embeddedCuts(snapshot)) {
			cut();
			if (fits()) return;
		}
	}
}

/** The snapshots inside a reconciliation result list, which is what `reconnect` replies carry. */
export function reconciliationSnapshots(results: readonly ControlReconciliationResult[]): ControlSessionSnapshot[] {
	const snapshots: ControlSessionSnapshot[] = [];
	for (const result of results) if (result.status !== "unknown") snapshots.push(result.snapshot);
	return snapshots;
}
