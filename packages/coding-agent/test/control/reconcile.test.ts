import { afterEach, describe, expect, it } from "bun:test";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	connectClient,
	createMockSessionFactory,
	createSessionFor,
	type MockSessionFactory,
	openSubscribedClient,
	subscribe,
	type TestClient,
} from "./harness";

const cleanups: Array<() => Promise<void>> = [];
const dirs: TempDir[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const dir of dirs.splice(0)) await dir.remove();
});

function workspace(label: string): TempDir {
	const dir = TempDir.createSync(`@control-reconcile-${label}-`);
	dirs.push(dir);
	return dir;
}

async function nextMatching(
	client: TestClient,
	predicate: (frame: Record<string, unknown>) => boolean,
	timeoutMs = 5_000,
) {
	for (;;) {
		const frame = await client.next(timeoutMs);
		if (predicate(frame)) return frame;
	}
}

/** A bearer-authenticated client on an existing daemon, handshaken and subscribed. */
async function reconnectingClient(url: string, headers: Record<string, string>): Promise<TestClient> {
	const client = await connectClient(url, headers);
	clients.push(client);
	await client.request({ version: 2, id: `hello-${crypto.randomUUID()}`, type: "hello", supportedVersions: [2] });
	await subscribe(client, `sub-${crypto.randomUUID()}`);
	return client;
}

async function setup(mock: MockModel, retention?: Parameters<typeof openSubscribedClient>[0]["retention"]) {
	const dir = workspace("main");
	const factory: MockSessionFactory = await createMockSessionFactory(mock);
	const opened = await openSubscribedClient({ mock, workspace: dir.path(), factory: factory.factory, retention });
	cleanups.push(() => opened.dispose());
	cleanups.push(() => factory.cleanup());
	return { opened, factory, dir };
}

describe("control retention and reconciliation", () => {
	it("expires an idle session after the idle TTL, then refuses it until its record is forgotten", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["done"] }] });
		const { opened, dir } = await setup(mock, { idleTtlMs: 120, tombstoneRetentionMs: 250, orphanGraceMs: 60_000 });
		const sessionId = await createSessionFor(opened.client, dir.path());

		expect(await nextMatching(opened.client, frame => frame.type === "session_expired")).toMatchObject({
			sessionId,
			reason: "idle_ttl",
		});
		const retired = await opened.client.request({
			version: 2,
			id: "p1",
			type: "prompt_session",
			sessionId,
			prompt: "late",
		});
		expect(retired.code).toBe("unsupported_operation");

		await Bun.sleep(350);
		const forgotten = await opened.client.request({
			version: 2,
			id: "p2",
			type: "prompt_session",
			sessionId,
			prompt: "later",
		});
		expect(forgotten.code).toBe("unknown_session");
	});

	it("never expires a session while its turn runs, and re-arms the idle clock when the turn settles", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["slow"], delayMs: 350 }],
		});
		const { opened, dir } = await setup(mock, {
			idleTtlMs: 100,
			tombstoneRetentionMs: 60_000,
			orphanGraceMs: 60_000,
		});
		const sessionId = await createSessionFor(opened.client, dir.path());
		await opened.client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "long" });

		const completed = await nextMatching(opened.client, frame => frame.type === "session_completed");
		expect(completed.sessionId).toBe(sessionId);
		expect(await nextMatching(opened.client, frame => frame.type === "session_expired")).toMatchObject({ sessionId });
	});

	it("reattaches to a retained active turn within the grace period and then delivers its live events", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["finished"], delayMs: 400 }],
		});
		const { opened, dir } = await setup(mock);
		const sessionId = await createSessionFor(opened.client, dir.path());
		await opened.client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "work" });
		await nextMatching(opened.client, frame => frame.type === "session_started");
		opened.client.close();

		const successor = await reconnectingClient(opened.server.url, opened.server.bearerHeaders);
		const taskRef = "00000000-0000-4000-8000-0000000000aa";
		const reconciled = await successor.request({
			version: 2,
			id: "r1",
			type: "reconnect",
			activeSessions: [{ sessionId, taskRef }],
		});
		expect(reconciled).toMatchObject({ type: "reconciled", inReplyTo: "r1" });
		const [entry] = reconciled.sessions as Array<Record<string, unknown>>;
		expect(entry).toMatchObject({ sessionId, status: "retained_active" });
		expect((entry.snapshot as Record<string, unknown>).status).toBe("active");

		expect(await nextMatching(successor, frame => frame.type === "session_completed")).toMatchObject({
			sessionId,
			output: "finished",
		});
	});

	it("does not present the previous turn's outcome in the snapshot of a session running a new turn", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["first"] }, { content: ["second"], delayMs: 400 }],
		});
		const { opened, dir } = await setup(mock);
		const sessionId = await createSessionFor(opened.client, dir.path());
		await opened.client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "one" });
		await nextMatching(opened.client, frame => frame.type === "session_completed");
		await opened.client.request({ version: 2, id: "p2", type: "prompt_session", sessionId, prompt: "two" });
		await nextMatching(opened.client, frame => frame.type === "session_started");
		opened.client.close();

		const successor = await reconnectingClient(opened.server.url, opened.server.bearerHeaders);
		const reconciled = await successor.request({
			version: 2,
			id: "r-stale",
			type: "reconnect",
			activeSessions: [{ sessionId, taskRef: "00000000-0000-4000-8000-0000000000aa" }],
		});
		const [entry] = reconciled.sessions as Array<Record<string, unknown>>;
		expect(entry).toMatchObject({ status: "retained_active" });
		expect(entry.snapshot).not.toHaveProperty("lastOutcome");
	});

	it("reports a turn that completed while disconnected as retained_idle with its outcome", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["early"], delayMs: 100 }],
		});
		const { opened, dir } = await setup(mock);
		const sessionId = await createSessionFor(opened.client, dir.path());
		await opened.client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "quick" });
		await nextMatching(opened.client, frame => frame.type === "session_started");
		opened.client.close();
		await Bun.sleep(300);

		const successor = await reconnectingClient(opened.server.url, opened.server.bearerHeaders);
		const reconciled = await successor.request({
			version: 2,
			id: "r2",
			type: "reconnect",
			activeSessions: [{ sessionId, taskRef: "00000000-0000-4000-8000-0000000000aa" }],
		});
		const [entry] = reconciled.sessions as Array<Record<string, unknown>>;
		expect(entry).toMatchObject({ sessionId, status: "retained_idle" });
		expect((entry.snapshot as Record<string, unknown>).lastOutcome).toMatchObject({
			type: "session_completed",
			output: "early",
		});
	});

	it("holds a detached session's events back from a subscribed successor until reconnect delivers the snapshot", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["while away"], delayMs: 200 }],
		});
		const { opened, dir } = await setup(mock);
		const sessionId = await createSessionFor(opened.client, dir.path());
		await opened.client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "work" });
		await nextMatching(opened.client, frame => frame.type === "session_started");
		opened.client.close();

		const successor = await reconnectingClient(opened.server.url, opened.server.bearerHeaders);
		await Bun.sleep(500);
		// The turn settled while the successor was subscribed but had not reconnected: no event may reach it.
		await expect(successor.next(150)).rejects.toThrow();

		const reconciled = await successor.request({
			version: 2,
			id: "r-barrier",
			type: "reconnect",
			activeSessions: [{ sessionId, taskRef: "00000000-0000-4000-8000-0000000000aa" }],
		});
		const [entry] = reconciled.sessions as Array<Record<string, unknown>>;
		expect((entry.snapshot as Record<string, unknown>).lastOutcome).toMatchObject({
			type: "session_completed",
			output: "while away",
		});
		// The outcome is recovered from the snapshot only; it is not delivered a second time as a live event.
		await expect(successor.next(150)).rejects.toThrow();
	});

	it("terminates a principal's sessions once its orphan grace runs out, then reports them completed", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["never"], delayMs: 5_000 }],
		});
		const { opened, dir } = await setup(mock, {
			idleTtlMs: 600_000,
			tombstoneRetentionMs: 60_000,
			orphanGraceMs: 120,
		});
		const sessionId = await createSessionFor(opened.client, dir.path());
		await opened.client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "abandoned" });
		await nextMatching(opened.client, frame => frame.type === "session_started");
		opened.client.close();
		await Bun.sleep(400);

		const successor = await reconnectingClient(opened.server.url, opened.server.bearerHeaders);
		const reconciled = await successor.request({
			version: 2,
			id: "r3",
			type: "reconnect",
			activeSessions: [{ sessionId, taskRef: "00000000-0000-4000-8000-0000000000aa" }],
		});
		const [entry] = reconciled.sessions as Array<Record<string, unknown>>;
		expect(entry).toMatchObject({ sessionId, status: "completed" });
		expect((entry.snapshot as Record<string, unknown>).status).toBe("terminated");
	});

	it("reports a reconnect with a pending question as waiting for a human, listing that question", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "ask",
							arguments: { questions: [{ id: "q1", question: "Proceed?", options: [{ label: "Yes" }] }] },
						},
					],
				},
				{ content: ["after"] },
			],
		});
		const { opened, dir } = await setup(mock);
		const sessionId = await createSessionFor(opened.client, dir.path());
		await opened.client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "ask me" });
		const requested = await nextMatching(opened.client, frame => frame.type === "decision_requested");
		opened.client.close();

		const successor = await reconnectingClient(opened.server.url, opened.server.bearerHeaders);
		const reconciled = await successor.request({
			version: 2,
			id: "r4",
			type: "reconnect",
			activeSessions: [{ sessionId, taskRef: "00000000-0000-4000-8000-0000000000aa" }],
		});
		const [entry] = reconciled.sessions as Array<Record<string, unknown>>;
		const snapshot = entry.snapshot as Record<string, unknown>;
		expect(snapshot.waitingHumanInput).toBe(true);
		expect(snapshot.pendingDecisions).toEqual([
			expect.objectContaining({ decisionId: requested.decisionId, question: "Proceed?" }),
		]);
	});

	it("shows another credential's handles as unknown to inspect and reconnect", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["x"] }] });
		const { opened, dir } = await setup(mock);
		const sessionId = await createSessionFor(opened.client, dir.path());
		const other = await reconnectingClient(opened.server.url, opened.server.keyHeaders);

		const inspected = await other.request({ version: 2, id: "i1", type: "inspect_session", sessionId });
		expect(inspected.code).toBe("unknown_session");
		const reconciled = await other.request({
			version: 2,
			id: "r5",
			type: "reconnect",
			activeSessions: [{ sessionId, taskRef: "00000000-0000-4000-8000-0000000000aa" }],
		});
		const [entry] = reconciled.sessions as Array<Record<string, unknown>>;
		expect(entry).toEqual({ sessionId, status: "unknown" });
	});

	it("rejects a reconnect with a repeated or malformed entry as a whole, attaching nothing", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["x"] }] });
		const { opened, dir } = await setup(mock);
		const sessionId = await createSessionFor(opened.client, dir.path());
		const taskRef = "00000000-0000-4000-8000-0000000000aa";

		const repeated = await opened.client.request({
			version: 2,
			id: "bad-1",
			type: "reconnect",
			activeSessions: [
				{ sessionId, taskRef },
				{ sessionId, taskRef },
			],
		});
		expect(repeated.code).toBe("invalid_message");
		const malformed = await opened.client.request({
			version: 2,
			id: "bad-2",
			type: "reconnect",
			activeSessions: [{ sessionId, taskRef: "not-a-uuid" }],
		});
		expect(malformed.code).toBe("invalid_message");
		const empty = await opened.client.request({ version: 2, id: "ok-0", type: "reconnect", activeSessions: [] });
		expect(empty).toEqual({ version: 2, inReplyTo: "ok-0", type: "reconciled", sessions: [] });
	});

	it("inspects a session's lifecycle and last outcome without changing it", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["answer"] }] });
		const { opened, dir } = await setup(mock);
		const sessionId = await createSessionFor(opened.client, dir.path());
		const before = await opened.client.request({ version: 2, id: "i0", type: "inspect_session", sessionId });
		expect(before).toMatchObject({ type: "session_inspected", sessionId, snapshot: { status: "idle" } });
		expect((before.snapshot as Record<string, unknown>).lastOutcome).toBeUndefined();

		await opened.client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "go" });
		await nextMatching(opened.client, frame => frame.type === "session_completed");
		const after = await opened.client.request({ version: 2, id: "i1", type: "inspect_session", sessionId });
		expect((after.snapshot as Record<string, unknown>).lastOutcome).toMatchObject({
			type: "session_completed",
			output: "answer",
		});
		expect((after.snapshot as Record<string, unknown>).status).toBe("idle");
	});
});
