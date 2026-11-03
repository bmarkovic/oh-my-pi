import { afterEach, describe, expect, it } from "bun:test";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
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

async function setup(mock: MockModel): Promise<{ client: TestClient; factory: MockSessionFactory; workspace: string }> {
	const dir = TempDir.createSync("@control-interrupt-");
	dirs.push(dir);
	const factory = await createMockSessionFactory(mock);
	const opened = await openSubscribedClient({ mock, workspace: dir.path(), factory: factory.factory });
	cleanups.push(() => opened.dispose());
	cleanups.push(() => factory.cleanup());
	return { client: opened.client, factory, workspace: dir.path() };
}

describe("control interrupt", () => {
	it("acks an interrupt, settles the active turn as session_interrupted, and lets a new prompt start fresh", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["slow"], delayMs: 3_000 }, { content: ["fresh"] }],
		});
		const { client, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace);

		expect(
			(await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "long" })).type,
		).toBe("ack");
		expect((await client.next()).type).toBe("session_started");
		while (mock.calls.length === 0) await Bun.sleep(5);

		expect(await client.request({ version: 2, id: "i1", type: "interrupt_session", sessionId })).toEqual({
			version: 2,
			inReplyTo: "i1",
			type: "ack",
		});
		const interrupted = await client.next();
		expect(interrupted).toMatchObject({ version: 2, type: "session_interrupted", sessionId });

		// The interrupted turn has no completed or failed outcome, so the next frame answers the new prompt.
		expect(
			(await client.request({ version: 2, id: "p2", type: "prompt_session", sessionId, prompt: "again" })).type,
		).toBe("ack");
		expect((await client.next()).type).toBe("session_started");
		expect(await client.next()).toMatchObject({ type: "session_completed", sessionId, output: "fresh" });
	}, 15_000);

	it("acks an interrupt on an idle session and emits nothing", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["done"] }] });
		const { client, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace);

		expect(await client.request({ version: 2, id: "idle-stop", type: "interrupt_session", sessionId })).toEqual({
			version: 2,
			inReplyTo: "idle-stop",
			type: "ack",
		});
		// Had the idle interrupt emitted an event, it would arrive before this reply.
		expect(
			(await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "go" })).type,
		).toBe("ack");
		expect((await client.next()).type).toBe("session_started");
		expect((await client.next()).type).toBe("session_completed");
		expect(mock.calls).toHaveLength(1);
	});

	it("answers an interrupt for an unknown handle with unknown_session", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["x"] }] });
		const { client } = await setup(mock);
		const reply = await client.request({
			version: 2,
			id: "ghost",
			type: "interrupt_session",
			sessionId: "00000000-0000-4000-8000-00000000dead",
		});
		expect(reply.code).toBe("unknown_session");
	});
});
