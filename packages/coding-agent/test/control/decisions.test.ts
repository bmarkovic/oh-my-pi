import { afterEach, describe, expect, it } from "bun:test";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	connectClient,
	createMockSessionFactory,
	createSessionFor,
	type MockSessionFactory,
	openSubscribedClient,
	type TestClient,
} from "./harness";

const cleanups: Array<() => Promise<void>> = [];
const dirs: TempDir[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const dir of dirs.splice(0)) await dir.remove();
});

async function setup(
	mock: MockModel,
): Promise<{ client: TestClient; factory: MockSessionFactory; workspace: string; url: string }> {
	const dir = TempDir.createSync("@control-decisions-");
	dirs.push(dir);
	const factory = await createMockSessionFactory(mock);
	const opened = await openSubscribedClient({ mock, workspace: dir.path(), factory: factory.factory });
	cleanups.push(() => opened.dispose());
	cleanups.push(() => factory.cleanup());
	return { client: opened.client, factory, workspace: dir.path(), url: opened.server.url };
}

function askCall(options: Array<{ label: string }>, extra: Record<string, unknown> = {}) {
	return {
		content: [
			{
				type: "toolCall" as const,
				name: "ask",
				arguments: { questions: [{ id: "q1", question: "Which way?", options, ...extra }] },
			},
		],
	};
}

/** Read frames until one of `type` arrives, skipping others. */
async function nextOfType(client: TestClient, type: string): Promise<Record<string, unknown>> {
	for (;;) {
		const frame = await client.next(3_000);
		if (frame.type === type) return frame;
	}
}

describe("control decisions", () => {
	it("publishes both options as decision_requested, and the chosen label reaches the model", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [askCall([{ label: "Alpha" }, { label: "Beta" }]), { content: ["went with it"] }],
		});
		const { client, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace);

		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "decide" });
		const requested = await nextOfType(client, "decision_requested");
		expect(requested).toMatchObject({ sessionId, allowFreeText: false });
		const options = requested.options as Array<{ optionId: string; label: string }>;
		// The ask tool appends its reserved free-text option; the two choices come first.
		expect(options.map(option => option.label)).toEqual(["Alpha", "Beta", "Other (type your own)"]);
		expect(new Set(options.map(option => option.optionId)).size).toBe(3);

		const decisionId = String(requested.decisionId);
		expect(
			await client.request({
				version: 2,
				id: "a1",
				type: "answer_decision",
				decisionId,
				optionId: options[1].optionId,
			}),
		).toEqual({ version: 2, inReplyTo: "a1", type: "ack" });
		expect(await nextOfType(client, "decision_answered")).toMatchObject({ sessionId, decisionId, optionId: "1" });
		expect(await nextOfType(client, "session_completed")).toMatchObject({ output: "went with it" });
		expect(JSON.stringify(mock.calls[1].context.messages)).toContain("Beta");
	});

	it("acknowledges an identical retry without a second event, and rejects a different answer", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [askCall([{ label: "Alpha" }, { label: "Beta" }]), { content: ["done"], delayMs: 400 }],
		});
		const { client, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "decide" });
		const decisionId = String((await nextOfType(client, "decision_requested")).decisionId);

		expect(
			await client.request({ version: 2, id: "a1", type: "answer_decision", decisionId, optionId: "0" }),
		).toEqual({ version: 2, inReplyTo: "a1", type: "ack" });
		expect((await nextOfType(client, "decision_answered")).optionId).toBe("0");
		expect(
			await client.request({ version: 2, id: "a2", type: "answer_decision", decisionId, optionId: "0" }),
		).toEqual({ version: 2, inReplyTo: "a2", type: "ack" });
		const different = await client.request({
			version: 2,
			id: "a3",
			type: "answer_decision",
			decisionId,
			optionId: "1",
		});
		expect(different.code).toBe("invalid_decision_state");
		await nextOfType(client, "session_completed");
		expect(mock.calls).toHaveLength(2);
	});

	it("keeps the question pending after a malformed answer", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [askCall([{ label: "Alpha" }]), { content: ["done"] }],
		});
		const { client, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "decide" });
		const decisionId = String((await nextOfType(client, "decision_requested")).decisionId);

		const both = await client.request({
			version: 2,
			id: "bad1",
			type: "answer_decision",
			decisionId,
			optionId: "0",
			text: "x",
		});
		expect(both.code).toBe("invalid_message");
		const freeText = await client.request({
			version: 2,
			id: "bad2",
			type: "answer_decision",
			decisionId,
			text: "free",
		});
		expect(freeText.code).toBe("invalid_message");

		expect(
			(await client.request({ version: 2, id: "ok", type: "answer_decision", decisionId, optionId: "0" })).type,
		).toBe("ack");
		expect((await nextOfType(client, "decision_answered")).optionId).toBe("0");
	});

	it("keeps a question pending when the session is steered, and delivers the steering after the answer", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [askCall([{ label: "Alpha" }, { label: "Beta" }]), { content: ["done"] }],
		});
		const { client, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "decide" });
		const decisionId = String((await nextOfType(client, "decision_requested")).decisionId);

		// Contract section 4.3: steering cannot silently answer or cancel a pending question.
		expect(
			await client.request({ version: 2, id: "steer", type: "prompt_session", sessionId, prompt: "STEER_TEXT" }),
		).toEqual({ version: 2, inReplyTo: "steer", type: "ack" });
		// Longer than the steering poll interval, so a steering-triggered cancellation would have landed.
		await Bun.sleep(700);

		const inspected = await client.request({ version: 2, id: "i1", type: "inspect_session", sessionId });
		expect(inspected.snapshot).toMatchObject({ status: "active", waitingHumanInput: true });
		expect((inspected.snapshot as { pendingDecisions: Array<{ decisionId: string }> }).pendingDecisions).toEqual([
			expect.objectContaining({ decisionId }),
		]);

		expect(
			await client.request({ version: 2, id: "a1", type: "answer_decision", decisionId, optionId: "1" }),
		).toEqual({ version: 2, inReplyTo: "a1", type: "ack" });
		expect(await nextOfType(client, "decision_answered")).toMatchObject({ decisionId, optionId: "1" });
		expect(await nextOfType(client, "session_completed")).toMatchObject({ sessionId, output: "done" });
		const seen = JSON.stringify(mock.calls[mock.calls.length - 1].context.messages);
		expect(seen).toContain("Beta");
		expect(seen).toContain("STEER_TEXT");
	}, 15_000);

	it("rejects an answer after an interrupt, and an answer from another credential", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [askCall([{ label: "Alpha" }]), { content: ["never"] }],
		});
		const { client, workspace, url } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "decide" });
		const decisionId = String((await nextOfType(client, "decision_requested")).decisionId);

		const other = await connectClient(url, { "X-Omp-Control-Key": "key-credential-for-tests" });
		cleanups.push(async () => other.close());
		await other.request({ version: 2, id: "other-hello", type: "hello", supportedVersions: [2] });
		await other.request({ version: 2, id: "other-sub", type: "subscribe_events" });
		const foreign = await other.request({
			version: 2,
			id: "foreign",
			type: "answer_decision",
			decisionId,
			optionId: "0",
		});
		expect(foreign.code).toBe("invalid_decision_state");

		expect((await client.request({ version: 2, id: "i1", type: "interrupt_session", sessionId })).type).toBe("ack");
		expect(await nextOfType(client, "session_interrupted")).toMatchObject({ sessionId });
		const late = await client.request({ version: 2, id: "late", type: "answer_decision", decisionId, optionId: "0" });
		expect(late.code).toBe("invalid_decision_state");
	});

	it("fails the turn with timeout when the human never answers within the deadline", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [askCall([{ label: "Alpha" }]), { content: ["never"] }],
		});
		const { client, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace, { timeoutMs: 400 });
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "decide" });
		await nextOfType(client, "decision_requested");

		expect(await nextOfType(client, "session_failed")).toMatchObject({ sessionId, code: "timeout" });
	}, 15_000);

	it("refuses a multi-select question without asking the human", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [askCall([{ label: "Alpha" }, { label: "Beta" }], { multi: true }), { content: ["moved on"] }],
		});
		const { client, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "decide" });

		expect(await nextOfType(client, "session_completed")).toMatchObject({ output: "moved on" });
		expect(mock.calls).toHaveLength(2);
	});
});
