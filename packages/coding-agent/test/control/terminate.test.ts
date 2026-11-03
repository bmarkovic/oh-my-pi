import { afterEach, describe, expect, it, spyOn } from "bun:test";
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
	const dir = TempDir.createSync("@control-terminate-");
	dirs.push(dir);
	const factory = await createMockSessionFactory(mock);
	const opened = await openSubscribedClient({ mock, workspace: dir.path(), factory: factory.factory });
	cleanups.push(() => opened.dispose());
	cleanups.push(() => factory.cleanup());
	return { client: opened.client, factory, workspace: dir.path() };
}

describe("control terminate", () => {
	it("settles an active turn with exactly one session_terminated, after the session is disposed", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["slow"], delayMs: 3_000 }],
		});
		const { client, factory, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace);
		const disposeSpy = spyOn(factory.sessions[0], "dispose");

		expect(
			(await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "long" })).type,
		).toBe("ack");
		expect((await client.next()).type).toBe("session_started");
		while (mock.calls.length === 0) await Bun.sleep(5);

		expect(await client.request({ version: 2, id: "t1", type: "terminate_session", sessionId })).toEqual({
			version: 2,
			inReplyTo: "t1",
			type: "ack",
		});
		const terminated = await client.next();
		expect(terminated).toMatchObject({ version: 2, type: "session_terminated", sessionId });

		expect(disposeSpy).toHaveBeenCalledTimes(1);
		// No completed or failed frame for the terminated turn: the next answer is the retired-handle error.
		const retired = await client.request({
			version: 2,
			id: "p2",
			type: "prompt_session",
			sessionId,
			prompt: "again",
		});
		expect(retired.code).toBe("unsupported_operation");
		expect(mock.calls).toHaveLength(1);
	});

	it("terminates an idle session with session_terminated and retires the handle for every later command", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["never"] }] });
		const { client, factory, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace);
		const disposeSpy = spyOn(factory.sessions[0], "dispose");

		expect(await client.request({ version: 2, id: "t1", type: "terminate_session", sessionId })).toEqual({
			version: 2,
			inReplyTo: "t1",
			type: "ack",
		});
		const terminated = await client.next();
		expect(terminated).toMatchObject({ type: "session_terminated", sessionId });
		expect(terminated.usage).toBeUndefined();
		expect(disposeSpy).toHaveBeenCalledTimes(1);

		for (const [id, type] of [
			["p2", "prompt_session"],
			["i2", "interrupt_session"],
			["t2", "terminate_session"],
		] as const) {
			const reply = await client.request({ version: 2, id, type, sessionId, prompt: "x" });
			expect(reply.code).toBe("unsupported_operation");
		}
		expect(mock.calls).toHaveLength(0);
	});

	it("announces one termination and starts no turn when terminate, terminate and prompt arrive back to back", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["never"] }] });
		const { client, factory, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace);
		const session = factory.sessions[0];
		const realDispose = session.dispose.bind(session);
		// A slow teardown keeps the handle retiring while the later commands arrive.
		const disposeSpy = spyOn(session, "dispose").mockImplementation(async () => {
			await Bun.sleep(100);
			return realDispose();
		});

		client.send({ version: 2, id: "t1", type: "terminate_session", sessionId });
		client.send({ version: 2, id: "t2", type: "terminate_session", sessionId });
		client.send({ version: 2, id: "p1", type: "prompt_session", sessionId, prompt: "too late" });

		const frames = [await client.next(), await client.next(), await client.next(), await client.next()];
		expect(frames.filter(frame => frame.type === "session_terminated")).toHaveLength(1);
		expect(frames.find(frame => frame.inReplyTo === "t2")).toMatchObject({ code: "unsupported_operation" });
		expect(frames.find(frame => frame.inReplyTo === "p1")).toMatchObject({ code: "unsupported_operation" });
		expect(frames.some(frame => frame.type === "session_started")).toBe(false);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
		expect(mock.calls).toHaveLength(0);
	});
});
