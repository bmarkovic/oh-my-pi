import { afterEach, describe, expect, it } from "bun:test";
import { type MockModel, createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
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

function workspace(label: string): TempDir {
	const dir = TempDir.createSync(`@control-turns-${label}-`);
	dirs.push(dir);
	return dir;
}

async function setup(
	mock: MockModel,
	label = "main",
): Promise<{ client: TestClient; factory: MockSessionFactory; dir: TempDir; url: string }> {
	const dir = workspace(label);
	const factory = await createMockSessionFactory(mock);
	const opened = await openSubscribedClient({ mock, workspace: dir.path(), factory: factory.factory });
	cleanups.push(() => opened.dispose());
	cleanups.push(() => factory.cleanup());
	return { client: opened.client, factory, dir, url: opened.server.url };
}

function promptFrame(id: string, sessionId: string, prompt: string): Record<string, unknown> {
	return { version: 2, id, type: "prompt_session", sessionId, prompt };
}

describe("control turns", () => {
	it("acks, starts and completes a scripted turn with its output and usage, in that order", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["pong"], usage: { input: 10, output: 4, totalTokens: 14 } }],
		});
		const { client, dir } = await setup(mock);
		const sessionId = await createSessionFor(client, dir.path());

		const ack = await client.request(promptFrame("p1", sessionId, "ping"));
		expect(ack).toEqual({ version: 2, inReplyTo: "p1", type: "ack" });
		const started = await client.next();
		expect(started).toMatchObject({ version: 2, type: "session_started", sessionId });
		expect(typeof started.at).toBe("number");
		const completed = await client.next();
		expect(completed).toMatchObject({
			version: 2,
			type: "session_completed",
			sessionId,
			output: "pong",
			usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
		});
		expect(completed.inReplyTo).toBeUndefined();
	});

	it("steers an active turn: the steer acks, starts nothing new and reaches the model", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["first"], delayMs: 200 }, { content: ["second"] }],
		});
		const { client, dir } = await setup(mock);
		const sessionId = await createSessionFor(client, dir.path());

		expect((await client.request(promptFrame("p1", sessionId, "start"))).type).toBe("ack");
		expect((await client.next()).type).toBe("session_started");
		// Steer only once the first model call is in flight, so the steer lands mid-turn.
		while (mock.calls.length === 0) await Bun.sleep(5);
		const steer = await client.request(promptFrame("p2", sessionId, "use the simpler plan"));
		expect(steer).toEqual({ version: 2, inReplyTo: "p2", type: "ack" });

		const completed = await client.next();
		expect(completed).toMatchObject({ type: "session_completed", output: "second" });
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[1].context.messages)).toContain("use the simpler plan");
	});

	it("settles a model error as session_failed with execution_failed and a nonempty error", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ throw: "upstream exploded" }] });
		const { client, dir } = await setup(mock);
		const sessionId = await createSessionFor(client, dir.path());

		await client.request(promptFrame("p1", sessionId, "boom"));
		expect((await client.next()).type).toBe("session_started");
		const failed = await client.next();
		expect(failed).toMatchObject({ type: "session_failed", sessionId, code: "execution_failed" });
		expect(String(failed.error).length).toBeGreaterThan(0);
		expect(String(failed.error)).toContain("upstream exploded");
	});

	it("settles a turn past timeoutMs as session_failed with timeout and accepts a new prompt afterwards", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["too slow"], delayMs: 2_000 }, { content: ["after"] }],
		});
		const { client, dir } = await setup(mock);
		const sessionId = await createSessionFor(client, dir.path(), { timeoutMs: 50 });

		await client.request(promptFrame("p1", sessionId, "slow"));
		expect((await client.next()).type).toBe("session_started");
		const failed = await client.next();
		expect(failed).toMatchObject({ type: "session_failed", sessionId, code: "timeout" });

		expect((await client.request(promptFrame("p2", sessionId, "again"))).type).toBe("ack");
		expect((await client.next()).type).toBe("session_started");
		expect(await client.next()).toMatchObject({ type: "session_completed", output: "after" });
	}, 15_000);

	it("keeps a turn budget past the 32-bit timer range instead of expiring it at once", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["finished"], delayMs: 300 }],
		});
		const { client, dir } = await setup(mock);
		// 3e9 ms is a valid positive safe integer (about 35 days); a timer given it directly fires after 1 ms.
		const sessionId = await createSessionFor(client, dir.path(), { timeoutMs: 3_000_000_000 });

		await client.request(promptFrame("p1", sessionId, "slow"));
		expect((await client.next()).type).toBe("session_started");
		expect(await client.next()).toMatchObject({ type: "session_completed", sessionId, output: "finished" });
	}, 15_000);

	it("rejects a zero or fractional timeoutMs at create_session, so no turn can start with an instant deadline", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["unused"] }] });
		const { client, dir } = await setup(mock);
		for (const timeoutMs of [0, 0.5, -1]) {
			const reply = await client.request({
				version: 2,
				id: `create-${timeoutMs}`,
				type: "create_session",
				workspacePath: dir.path(),
				taskRef: "00000000-0000-4000-8000-0000000000aa",
				model: "mock/model-a",
				timeoutMs,
			});
			expect(reply).toMatchObject({ type: "error", code: "invalid_message" });
		}
	});

	it("keeps two sessions in two workspaces independent, each event carrying its own sessionId", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			handler: context => {
				const last = context.messages[context.messages.length - 1];
				const text =
					typeof last.content === "string"
						? last.content
						: last.content.map(block => ("text" in block ? block.text : "")).join("");
				return { content: [`echo:${text}`] };
			},
		});
		const first = workspace("alpha");
		const second = workspace("beta");
		const factory = await createMockSessionFactory(mock);
		const opened = await openSubscribedClient({ mock, workspace: first.path(), factory: factory.factory });
		cleanups.push(() => opened.dispose());
		cleanups.push(() => factory.cleanup());
		const { client } = opened;
		const sessionA = await createSessionFor(client, first.path());
		const sessionB = await createSessionFor(client, second.path());

		client.send(promptFrame("pa", sessionA, "alpha-task"));
		client.send(promptFrame("pb", sessionB, "beta-task"));
		const acks = new Set<string>();
		const started = new Set<string>();
		const outcomes = new Map<string, string>();
		while (outcomes.size < 2) {
			const frame = await client.next();
			if (frame.type === "ack") acks.add(String(frame.inReplyTo));
			if (frame.type === "session_started") started.add(String(frame.sessionId));
			if (frame.type === "session_completed") outcomes.set(String(frame.sessionId), String(frame.output));
		}
		expect([...acks].sort()).toEqual(["pa", "pb"]);
		expect([...started].sort()).toEqual([sessionA, sessionB].sort());
		// The session prepends a dated system reminder to user text, so assert containment and isolation.
		expect(outcomes.get(sessionA)).toContain("alpha-task");
		expect(outcomes.get(sessionA)).not.toContain("beta-task");
		expect(outcomes.get(sessionB)).toContain("beta-task");
		expect(outcomes.get(sessionB)).not.toContain("alpha-task");
	});

	it("refuses prompt_session before subscribe_events and never reaches the model", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["never"] }] });
		const dir = workspace("unsubscribed");
		const factory = await createMockSessionFactory(mock);
		cleanups.push(() => factory.cleanup());
		const opened = await openSubscribedClient({ mock, workspace: dir.path(), factory: factory.factory });
		cleanups.push(() => opened.dispose());
		const bare = await connectClient(opened.server.url, opened.server.bearerHeaders);
		cleanups.push(async () => bare.close());
		await bare.request({ version: 2, id: "hello-bare", type: "hello", supportedVersions: [2] });
		const reply = await bare.request(promptFrame("p-bare", "any", "hi"));
		expect(reply.code).toBe("unsupported_operation");
		expect(mock.calls).toHaveLength(0);
	});

	it("answers prompt_session for another credential's handle with unknown_session", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["owned"] }] });
		const { client, dir, factory, url } = await setup(mock);
		const sessionId = await createSessionFor(client, dir.path());
		const other = await connectClient(url, { "X-Omp-Control-Key": "key-credential-for-tests" });
		cleanups.push(async () => other.close());
		await other.request({ version: 2, id: "other-hello", type: "hello", supportedVersions: [2] });
		await other.request({ version: 2, id: "other-sub", type: "subscribe_events" });
		const reply = await other.request(promptFrame("steal", sessionId, "hijack"));
		expect(reply.code).toBe("unknown_session");
		expect(factory.requests).toHaveLength(1);
		expect(mock.calls).toHaveLength(0);
	});
});
