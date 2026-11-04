import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createMockSessionFactory,
	createSessionFor,
	type MockSessionFactory,
	openSubscribedClient,
	type TestClient,
	upgradeStatus,
} from "./harness";

const cleanups: Array<() => Promise<void>> = [];
const dirs: TempDir[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const dir of dirs.splice(0)) await dir.remove();
});

function textOf(message: { content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map(block => (typeof block === "object" && block !== null && "text" in block ? String(block.text) : ""))
		.join("");
}

function hasUserText(context: Context, marker: string): boolean {
	return context.messages.some(message => message.role === "user" && textOf(message).includes(marker));
}

function lastRole(context: Context): string | undefined {
	return context.messages[context.messages.length - 1]?.role;
}

/** Root spawns a child (`CHILD_TASK`); the child runs `childStep` and never finishes on its own while it is slow. */
function treeMock(childStep: (context: Context) => MockResponse): MockModel {
	return createMockModel({
		provider: "mock",
		id: "model-a",
		handler: context => {
			if (hasUserText(context, "CHILD_TASK")) return childStep(context);
			if (lastRole(context) === "toolResult") return { content: ["root done"] };
			return {
				content: [
					{
						type: "toolCall",
						name: "task",
						arguments: { agent: "task", task: "CHILD_TASK compute", solutionSpace: "answer only" },
					},
				],
			};
		},
	});
}

async function setup(mock: MockModel) {
	const dir = TempDir.createSync("@control-shutdown-");
	dirs.push(dir);
	const factory: MockSessionFactory = await createMockSessionFactory(mock);
	const opened = await openSubscribedClient({ mock, workspace: dir.path(), factory: factory.factory });
	cleanups.push(() => opened.dispose());
	cleanups.push(() => factory.cleanup());
	return { ...opened, factory, workspace: dir.path() };
}

/** Read frames until `predicate` matches, returning every frame read so far in order. */
async function readUntil(
	client: TestClient,
	predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Array<Record<string, unknown>>> {
	const frames: Array<Record<string, unknown>> = [];
	for (;;) {
		const frame = await client.next(10_000);
		frames.push(frame);
		if (predicate(frame)) return frames;
	}
}

/** Read frames until the socket closes, returning the frames and the close code. */
async function readToClose(client: TestClient): Promise<{ frames: Array<Record<string, unknown>>; code: number }> {
	const frames: Array<Record<string, unknown>> = [];
	const closed = client.closedWithin(10_000);
	for (;;) {
		const next = client.next(200).then(
			frame => ({ frame }),
			() => undefined,
		);
		const result = await Promise.race([next, closed.then(() => undefined)]);
		if (result === undefined) break;
		frames.push(result.frame);
	}
	const event = await closed;
	return { frames, code: event.code };
}

describe("control daemon shutdown", () => {
	it("settles an active turn as daemon_shutdown, then terminates it, then terminates the idle session and closes 1001", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["slow"], delayMs: 10_000 }],
		});
		const { client, server, control, workspace } = await setup(mock);
		const active = await createSessionFor(client, workspace);
		const idle = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: active, prompt: "long" });
		await readUntil(client, frame => frame.type === "session_started" && frame.sessionId === active);

		server.stopAccepting();
		const stopping = control.shutdown().then(() => server.close());
		const { frames, code } = await readToClose(client);
		await stopping;

		const forActive = frames.filter(frame => frame.sessionId === active).map(frame => frame.type);
		expect(forActive).toEqual(["session_failed", "session_terminated"]);
		expect(frames.find(frame => frame.sessionId === active && frame.type === "session_failed")).toMatchObject({
			code: "daemon_shutdown",
		});
		expect(frames.filter(frame => frame.sessionId === idle).map(frame => frame.type)).toEqual(["session_terminated"]);
		expect(code).toBe(1001);
	}, 30_000);

	it("settles a child before its parent, so the child's failure and termination precede the root's", async () => {
		const mock = treeMock(() => ({ content: ["slow"], delayMs: 10_000 }));
		const { client, server, control, workspace } = await setup(mock);
		const root = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });
		const childStarted = await readUntil(
			client,
			frame => frame.type === "session_started" && frame.parentSessionId === root,
		);
		const child = String(childStarted[childStarted.length - 1].sessionId);

		server.stopAccepting();
		const stopping = control.shutdown().then(() => server.close());
		const { frames } = await readToClose(client);
		await stopping;

		const order = frames.map(
			frame => `${frame.sessionId === child ? "child" : frame.sessionId === root ? "root" : "other"}:${frame.type}`,
		);
		const indexOf = (label: string) => order.indexOf(label);
		expect(indexOf("child:session_failed")).toBeGreaterThanOrEqual(0);
		expect(indexOf("child:session_failed")).toBeLessThan(indexOf("child:session_terminated"));
		expect(indexOf("child:session_terminated")).toBeLessThan(indexOf("root:session_failed"));
		expect(indexOf("root:session_failed")).toBeLessThan(indexOf("root:session_terminated"));
	}, 30_000);

	it("disposes a detached orphan's session at shutdown, even though no connection is attached to it", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["idle"] }] });
		const { client, server, control, workspace, factory } = await setup(mock);
		await createSessionFor(client, workspace);
		client.close();
		await Bun.sleep(20);
		const session = factory.sessions[factory.sessions.length - 1];
		const dispose = spyOn(session, "dispose");

		server.stopAccepting();
		await control.shutdown();
		await server.close();
		expect(dispose).toHaveBeenCalled();
	});

	it("refuses new work while draining and accepts no new connection", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["slow"], delayMs: 10_000 }],
		});
		const { client, server, control, workspace } = await setup(mock);
		const active = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: active, prompt: "long" });
		await readUntil(client, frame => frame.type === "session_started" && frame.sessionId === active);

		server.stopAccepting();
		const stopping = control.shutdown().then(() => server.close());
		const refused = await client.request({
			version: 2,
			id: "c1",
			type: "create_session",
			workspacePath: workspace,
			taskRef: "00000000-0000-4000-8000-0000000000aa",
		});
		expect(refused).toMatchObject({ code: "unsupported_operation", message: "daemon is shutting down" });
		await expect(upgradeStatus(server.url, server.bearerHeaders)).rejects.toThrow();
		await readToClose(client);
		await stopping;
	}, 30_000);

	it("refuses a create_session still being built when shutdown starts, and disposes what it built", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["idle"] }] });
		const dir = TempDir.createSync("@control-shutdown-late-create-");
		dirs.push(dir);
		const mockFactory: MockSessionFactory = await createMockSessionFactory(mock);
		cleanups.push(() => mockFactory.cleanup());
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let built = 0;
		let disposals = 0;
		const opened = await openSubscribedClient({
			mock,
			workspace: dir.path(),
			factory: async request => {
				entered.resolve();
				await release.promise;
				const handle = await mockFactory.factory(request);
				built++;
				const dispose = handle.session.dispose.bind(handle.session);
				spyOn(handle.session, "dispose").mockImplementation(async () => {
					disposals++;
					await dispose();
				});
				return handle;
			},
		});
		cleanups.push(() => opened.dispose());

		const pending = opened.client.request({
			version: 2,
			id: "late-create",
			type: "create_session",
			workspacePath: dir.path(),
			taskRef: "00000000-0000-4000-8000-0000000000aa",
			model: "mock/model-a",
		});
		await entered.promise;
		opened.server.stopAccepting();
		await opened.control.shutdown();
		release.resolve();

		expect(await pending).toMatchObject({
			type: "error",
			code: "unsupported_operation",
			message: "daemon is shutting down",
		});
		expect(built).toBe(1);
		expect(disposals).toBe(1);
	}, 30_000);

	it("returns within the deadline when a session's dispose never settles, and still closes its sockets 1001", async () => {
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["idle"] }] });
		const { client, server, control, workspace, factory } = await setup(mock);
		await createSessionFor(client, workspace);
		const session = factory.sessions[factory.sessions.length - 1];
		const hung = spyOn(session, "dispose").mockImplementation(() => new Promise<void>(() => {}));

		server.stopAccepting();
		const started = performance.now();
		await control.shutdown({ deadlineMs: 200 });
		await server.close();
		expect(performance.now() - started).toBeLessThan(2_000);
		const { code } = await readToClose(client);
		expect(code).toBe(1001);
		// Let the afterEach teardown dispose the session for real; a dispose that never settles would hang it.
		hung.mockRestore();
	}, 30_000);
});
