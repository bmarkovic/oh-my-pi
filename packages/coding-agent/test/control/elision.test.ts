import { describe, expect, it } from "bun:test";
import {
	ControlConnection,
	type ControlOperationHandler,
	type ControlSocket,
} from "../../src/modes/control/control-connection";
import { ControlDecisionStore } from "../../src/modes/control/control-decisions";
import type { ControlSessionSnapshot } from "../../src/modes/control/control-reconcile";
import {
	cutEmbeddedEvents,
	elideDecisionRequested,
	elideEvent,
	frameBytes,
} from "../../src/modes/control/wire/elision";
import { CONTROL_MAX_MESSAGE_BYTES } from "../../src/modes/control/wire/envelope";
import type { ControlEvent, DecisionRequestedEvent } from "../../src/modes/control/wire/events";

const L = CONTROL_MAX_MESSAGE_BYTES;
const MIB = 1024 * 1024;
const TIMING = { helloTimeoutMs: 60_000, pingIntervalMs: 60_000, livenessTimeoutMs: 60_000 };

function completed(output: string): ControlEvent {
	return { version: 2, type: "session_completed", sessionId: "s1", at: 1, output };
}

function question(text: string, labels: string[]): DecisionRequestedEvent {
	return {
		version: 2,
		type: "decision_requested",
		sessionId: "s1",
		at: 1,
		decisionId: "d1",
		question: text,
		options: labels.map((label, index) => ({ optionId: String(index), label })),
		allowFreeText: false,
	};
}

describe("oversize event elision", () => {
	it("cuts a 17 MiB output to a frame within the limit, keeps a prefix, and marks the cut", () => {
		const output = "a".repeat(17 * MIB);
		const delivered = elideEvent(completed(output));
		expect(frameBytes(delivered)).toBeLessThanOrEqual(L);
		expect(delivered).toMatchObject({ type: "session_completed", elided: ["/output"] });
		if (delivered.type !== "session_completed") throw new Error("unexpected event");
		expect(delivered.output.length).toBeGreaterThan(0);
		expect(output.startsWith(delivered.output)).toBe(true);
	});

	it("never splits a surrogate pair, so the elided frame still parses", () => {
		const output = 'é😀"'.repeat((6 * MIB) / 4);
		const delivered = elideEvent(completed(output));
		expect(frameBytes(delivered)).toBeLessThanOrEqual(L);
		if (delivered.type !== "session_completed") throw new Error("unexpected event");
		expect(output.startsWith(delivered.output)).toBe(true);
		const reparsed = JSON.parse(JSON.stringify(delivered)) as { output: string };
		expect(reparsed.output).toBe(delivered.output);
		expect(/[\uD800-\uDBFF]$/.test(delivered.output)).toBe(false);
	});

	it("returns a frame that already fits as the same object, unchanged", () => {
		const small = completed("short answer");
		expect(elideEvent(small)).toBe(small);
	});

	it("cuts a 17 MiB failure error and keeps it nonempty", () => {
		const failed: ControlEvent = {
			version: 2,
			type: "session_failed",
			sessionId: "s1",
			at: 1,
			code: "execution_failed",
			error: "e".repeat(17 * MIB),
		};
		const delivered = elideEvent(failed);
		expect(frameBytes(delivered)).toBeLessThanOrEqual(L);
		if (delivered.type !== "session_failed") throw new Error("unexpected event");
		expect(delivered.error.length).toBeGreaterThan(0);
		expect(delivered.elided).toEqual(["/error"]);
	});

	it("drops a decision's context before cutting its question, and keeps every id and option id", () => {
		const base = question("Which way?", ["Alpha", "Beta"]);
		const withContext: DecisionRequestedEvent = { ...base, context: { notes: "c".repeat(17 * MIB) } };
		const delivered = elideDecisionRequested(withContext, L);
		expect(frameBytes(delivered)).toBeLessThanOrEqual(L);
		expect(delivered.context).toBeUndefined();
		expect(delivered.elided).toEqual(["/context"]);
		expect(delivered.decisionId).toBe("d1");
		expect(delivered.options.map(option => option.optionId)).toEqual(["0", "1"]);
		expect(delivered.question).toBe("Which way?");
	});

	it("cuts an oversize question, then equal byte shares of the labels when the question alone is not enough", () => {
		const labels = Array.from({ length: 8 }, () => "L".repeat(3 * MIB));
		const delivered = elideDecisionRequested(question("q".repeat(MIB), labels), L);
		expect(frameBytes(delivered)).toBeLessThanOrEqual(L);
		expect(delivered.elided).toContain("/options/0/label");
		expect(delivered.options.map(option => option.optionId)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
		const sizes = delivered.options.map(option => option.label.length);
		expect(Math.min(...sizes)).toBeGreaterThan(0);
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
	});

	it("keeps the question nonempty when an oversize label is what pushes the frame over the limit", () => {
		const delivered = elideDecisionRequested(question("Which way?", ["L".repeat(20 * MIB), "Beta"]), L);
		expect(frameBytes(delivered)).toBeLessThanOrEqual(L);
		// The client rejects an empty question, so the cut leaves at least the first code point.
		expect(delivered.question.length).toBeGreaterThan(0);
		expect("Which way?".startsWith(delivered.question)).toBe(true);
		expect(delivered.elided).toContain("/options/0/label");
		expect(delivered.options.map(option => option.optionId)).toEqual(["0", "1"]);
		expect(delivered.options[1].label).toBe("Beta");
	});

	it("lists a field once when an event that was already cut is cut again for an embedded reply", () => {
		const delivered = elideEvent(completed("a".repeat(17 * MIB)));
		const embedded = elideEvent(delivered, 4_096);
		expect(frameBytes(embedded)).toBeLessThanOrEqual(4_096);
		expect(embedded).toMatchObject({ type: "session_completed", elided: ["/output"] });
	});

	it("keeps the pointers a decision already carries when it is cut again", () => {
		const delivered = elideDecisionRequested(
			{ ...question("Which way?", ["Alpha", "Beta"]), context: { notes: "c".repeat(17 * MIB) } },
			L,
		);
		expect(delivered.elided).toEqual(["/context"]);
		const embedded = elideDecisionRequested({ ...delivered, question: "q".repeat(8_192) }, 4_096);
		expect(frameBytes(embedded)).toBeLessThanOrEqual(4_096);
		expect(embedded.elided).toEqual(["/context", "/question"]);
	});

	it("cuts a 17 MiB answer text and records the pointer", () => {
		const answered: ControlEvent = {
			version: 2,
			type: "decision_answered",
			sessionId: "s1",
			at: 1,
			decisionId: "d1",
			text: "t".repeat(17 * MIB),
		};
		const delivered = elideEvent(answered);
		expect(frameBytes(delivered)).toBeLessThanOrEqual(L);
		expect(delivered).toMatchObject({ type: "decision_answered", elided: ["/text"] });
	});

	it("cuts embedded outcomes of a reply to 4 KiB, descendants before the root", () => {
		const big = (sessionId: string): ControlEvent => ({ ...completed("o".repeat(10 * MIB)), sessionId });
		const snapshot: ControlSessionSnapshot = {
			taskRef: "00000000-0000-4000-8000-0000000000aa",
			status: "idle",
			waitingHumanInput: false,
			pendingDecisions: [],
			lastOutcome: big("root"),
			descendants: [
				{
					sessionId: "child",
					parentSessionId: "root",
					status: "idle",
					waitingHumanInput: false,
					pendingDecisions: [],
					lastOutcome: big("child"),
				},
			],
		};
		const reply = () => ({ type: "reconciled", sessions: [snapshot] });
		cutEmbeddedEvents([snapshot], () => frameBytes(reply()) <= L);
		expect(frameBytes(reply())).toBeLessThanOrEqual(L);
		// Only the child needed cutting; the root's own outcome stays whole.
		expect(snapshot.descendants[0].lastOutcome).toMatchObject({ elided: ["/output"] });
		expect(snapshot.lastOutcome).toMatchObject({ sessionId: "root" });
		expect(snapshot.lastOutcome && "elided" in snapshot.lastOutcome).toBe(false);
		expect(snapshot.status).toBe("idle");
	});
});

describe("connection defect guard", () => {
	it("closes 1011 and sends nothing when a frame is still over the limit after elision", () => {
		const sent: string[] = [];
		const closes: Array<{ code: number }> = [];
		const socket: ControlSocket = {
			send: text => {
				sent.push(text);
				return 1;
			},
			bufferedAmount: () => 0,
			close: code => closes.push({ code }),
			ping: () => {},
			terminate: () => {},
		};
		const connection = new ControlConnection({
			socket,
			principal: "bearer",
			timing: TIMING,
			operations: new Map<string, ControlOperationHandler>(),
		});
		connection.reply({ type: "defect", payload: "x".repeat(L) });
		expect(sent).toEqual([]);
		expect(closes).toEqual([{ code: 1011 }]);
		connection.dispose();
	});
});

describe("decision store and oversize questions", () => {
	it("refuses a decision that cannot fit a frame even with minimal labels, so nothing unanswerable is asked", async () => {
		const published: ControlEvent[] = [];
		const store = new ControlDecisionStore((_principal, event) => {
			published.push(event);
			return event;
		}, 60_000);
		const options = Array.from({ length: 600_000 }, (_unused, index) => ({ label: `option ${index}` }));
		await expect(
			store.request("s1", "bearer", { question: "Pick one", options, allowFreeText: false }),
		).rejects.toThrow("too large for a control frame");
		expect(published).toEqual([]);
		expect(store.pendingFor("s1")).toBeUndefined();
	}, 60_000);
});

describe("oversize question through the decision store", () => {
	it("delivers a 17 MiB question elided, stores that same form as pending, and an option answer releases the asker", async () => {
		const published: ControlEvent[] = [];
		const store = new ControlDecisionStore((_principal, event) => {
			published.push(event);
			return event;
		}, 60_000);
		const questionText = "Q".repeat(17 * MIB);
		const asking = store.request("s1", "bearer", {
			question: questionText,
			options: [{ label: "Alpha" }, { label: "Beta" }],
			allowFreeText: false,
		});

		const [delivered] = published;
		if (delivered?.type !== "decision_requested") throw new Error("expected a decision_requested frame");
		expect(frameBytes(delivered)).toBeLessThanOrEqual(L);
		expect(delivered.elided).toEqual(["/question"]);
		expect(questionText.startsWith(delivered.question)).toBe(true);
		expect(delivered.options.map(option => option.optionId)).toEqual(["0", "1"]);
		expect(store.pendingFor("s1")).toEqual(delivered);

		const answer = store.answer("bearer", { decisionId: delivered.decisionId, optionId: "1" });
		expect(answer.kind).toBe("accepted");
		if (answer.kind === "accepted") store.release(answer.decisionId);
		expect(await asking).toEqual({ optionId: "1" });
	});
});
