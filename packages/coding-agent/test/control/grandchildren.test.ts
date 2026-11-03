import { afterEach, describe, expect, it } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	connectClient,
	createMockSessionFactory,
	createSessionFor,
	handshake,
	type MockSessionFactory,
	openSubscribedClient,
	subscribe,
	type TestClient,
} from "./harness";

const cleanups: Array<() => Promise<void>> = [];
const dirs: TempDir[] = [];
const ROOT_TASK = "00000000-0000-4000-8000-0000000000aa";

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

/** True when a user message of the context contains `marker`. Grandchild markers contain the child marker, so test them first. */
function hasUserText(context: Context, marker: string): boolean {
	return context.messages.some(message => message.role === "user" && textOf(message).includes(marker));
}

function lastRole(context: Context): string | undefined {
	return context.messages[context.messages.length - 1]?.role;
}

function spawn(task: string): MockResponse {
	return {
		content: [{ type: "toolCall", name: "task", arguments: { agent: "task", task, solutionSpace: "answer only" } }],
	};
}

/**
 * Scripted three-level tree. The root spawns a child (`CHILD_TASK`), the child spawns a grandchild
 * (`GRANDCHILD_TASK`). The grandchild answers with `grandchildStep`; the others finish after their spawn returns.
 */
function treeMock(
	grandchildStep: (context: Context) => MockResponse = () => ({ content: ["grandchild answer"] }),
): MockModel {
	return createMockModel({
		provider: "mock",
		id: "model-a",
		handler: context => {
			if (hasUserText(context, "GRANDCHILD_TASK")) return grandchildStep(context);
			if (hasUserText(context, "CHILD_TASK")) {
				return lastRole(context) === "toolResult" ? { content: ["child done"] } : spawn("GRANDCHILD_TASK compute");
			}
			return lastRole(context) === "toolResult" ? { content: ["root done"] } : spawn("CHILD_TASK compute");
		},
	});
}

async function setup(mock: MockModel): Promise<{
	client: TestClient;
	url: string;
	bearerHeaders: Record<string, string>;
	workspace: string;
	dispose(): Promise<void>;
}> {
	const dir = TempDir.createSync("@control-grandchildren-");
	dirs.push(dir);
	const factory: MockSessionFactory = await createMockSessionFactory(mock);
	const opened = await openSubscribedClient({ mock, workspace: dir.path(), factory: factory.factory });
	cleanups.push(() => opened.dispose());
	cleanups.push(() => factory.cleanup());
	return {
		client: opened.client,
		url: opened.server.url,
		bearerHeaders: opened.server.bearerHeaders,
		workspace: dir.path(),
		dispose: () => opened.dispose(),
	};
}

/** Read frames until one matches, recording every frame read on the way. */
async function nextMatching(
	client: TestClient,
	predicate: (frame: Record<string, unknown>) => boolean,
	seen: Array<Record<string, unknown>> = [],
): Promise<Record<string, unknown>> {
	for (;;) {
		const frame = await client.next(5_000);
		seen.push(frame);
		if (predicate(frame)) return frame;
	}
}

interface EndpointCall {
	body: unknown;
	authorization: string | null;
}

const LOOKUP_TOKEN = "grandchild-tool-token-for-tests";

/** A loopback endpoint that records each call. */
function startEndpoint(): { url: string; calls: EndpointCall[] } {
	const calls: EndpointCall[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const text = await request.text();
			calls.push({
				body: text.length > 0 ? JSON.parse(text) : undefined,
				authorization: request.headers.get("authorization"),
			});
			return Response.json({ record: "seven" });
		},
	});
	cleanups.push(async () => {
		await server.stop(true);
	});
	return { url: `http://127.0.0.1:${server.port}`, calls };
}

describe("control grandchild handles", () => {
	it("gives a grandchild the root's tool bindings, so its call reaches the endpoint with the root's token", async () => {
		const endpoint = startEndpoint();
		const mock = treeMock(context =>
			lastRole(context) === "toolResult"
				? { content: ["looked up"] }
				: { content: [{ type: "toolCall", name: "lookup", arguments: { id: 7 } }] },
		);
		const { client, workspace } = await setup(mock);
		const root = await createSessionFor(client, workspace, {
			tools: [
				{
					name: "lookup",
					description: "Look up a record by id",
					endpointUrl: `${endpoint.url}/lookup`,
					authToken: LOOKUP_TOKEN,
					schema: {
						type: "object",
						properties: { id: { type: "integer" } },
						required: ["id"],
						additionalProperties: false,
					},
				},
			],
		});
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });
		const child = String(
			(await nextMatching(client, f => f.type === "session_started" && f.parentSessionId === root)).sessionId,
		);
		const grandchild = String(
			(await nextMatching(client, f => f.type === "session_started" && f.parentSessionId === child)).sessionId,
		);
		expect(
			await nextMatching(client, f => f.type === "session_completed" && f.sessionId === grandchild),
		).toMatchObject({
			output: "looked up",
		});
		expect(endpoint.calls).toEqual([{ body: { id: 7 }, authorization: `Bearer ${LOOKUP_TOKEN}` }]);
	});

	it("announces a grandchild after its child, with the child as its parent, on the root's connection", async () => {
		const { client, workspace } = await setup(treeMock());
		const root = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });

		const childStarted = await nextMatching(client, f => f.type === "session_started" && f.parentSessionId === root);
		const child = String(childStarted.sessionId);
		const grandchildStarted = await nextMatching(
			client,
			f => f.type === "session_started" && f.parentSessionId === child,
		);
		expect(grandchildStarted.sessionId).not.toBe(child);
		expect(grandchildStarted.sessionId).not.toBe(root);
		expect(await nextMatching(client, f => f.type === "session_completed" && f.sessionId === root)).toMatchObject({
			output: "root done",
		});
	});

	it("lists only direct children from enumerate, and a child lists its own grandchild", async () => {
		const { client, workspace } = await setup(treeMock());
		const root = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });
		const child = String(
			(await nextMatching(client, f => f.type === "session_started" && f.parentSessionId === root)).sessionId,
		);
		const grandchild = String(
			(await nextMatching(client, f => f.type === "session_started" && f.parentSessionId === child)).sessionId,
		);
		await nextMatching(client, f => f.type === "session_completed" && f.sessionId === root);

		const fromRoot = await client.request({
			version: 2,
			id: "e1",
			type: "enumerate_child_sessions",
			parentSessionId: root,
		});
		expect(fromRoot).toMatchObject({ type: "child_sessions", parentSessionId: root, childSessionIds: [child] });
		const fromChild = await client.request({
			version: 2,
			id: "e2",
			type: "enumerate_child_sessions",
			parentSessionId: child,
		});
		expect(fromChild).toMatchObject({
			type: "child_sessions",
			parentSessionId: child,
			childSessionIds: [grandchild],
		});
	});

	it("refuses prompt, interrupt and terminate on a grandchild handle as unsupported", async () => {
		const { client, workspace } = await setup(treeMock());
		const root = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });
		const child = String(
			(await nextMatching(client, f => f.type === "session_started" && f.parentSessionId === root)).sessionId,
		);
		const grandchild = String(
			(await nextMatching(client, f => f.type === "session_started" && f.parentSessionId === child)).sessionId,
		);
		await nextMatching(client, f => f.type === "session_completed" && f.sessionId === root);

		const prompt = await client.request({
			version: 2,
			id: "x1",
			type: "prompt_session",
			sessionId: grandchild,
			prompt: "hi",
		});
		expect(prompt.code).toBe("unsupported_operation");
		const interrupt = await client.request({
			version: 2,
			id: "x2",
			type: "interrupt_session",
			sessionId: grandchild,
		});
		expect(interrupt.code).toBe("unsupported_operation");
		const terminate = await client.request({
			version: 2,
			id: "x3",
			type: "terminate_session",
			sessionId: grandchild,
		});
		expect(terminate.code).toBe("unsupported_operation");
	});

	it("reports a reconnect snapshot with every descendant depth-first, each under its immediate parent", async () => {
		const { client, workspace, url, bearerHeaders, dispose } = await setup(treeMock());
		const root = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });
		const child = String(
			(await nextMatching(client, f => f.type === "session_started" && f.parentSessionId === root)).sessionId,
		);
		const grandchild = String(
			(await nextMatching(client, f => f.type === "session_started" && f.parentSessionId === child)).sessionId,
		);
		await nextMatching(client, f => f.type === "session_completed" && f.sessionId === root);
		client.close();

		const successor = await connectClient(url, bearerHeaders);
		cleanups.push(async () => successor.close());
		await handshake(successor);
		await subscribe(successor);
		const reconciled = await successor.request({
			version: 2,
			id: "r1",
			type: "reconnect",
			activeSessions: [{ sessionId: root, taskRef: ROOT_TASK }],
		});
		const [entry] = reconciled.sessions as Array<Record<string, unknown>>;
		const snapshot = entry.snapshot as { descendants: Array<{ sessionId: string; parentSessionId: string }> };
		expect(snapshot.descendants.map(d => [d.sessionId, d.parentSessionId])).toEqual([
			[child, root],
			[grandchild, child],
		]);
		await dispose().catch(() => undefined);
	});

	it("terminates the grandchild before its child, and the child before the root", async () => {
		const { client, workspace } = await setup(treeMock(() => ({ content: ["late"], delayMs: 4_000 })));
		const root = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });
		const child = String(
			(await nextMatching(client, f => f.type === "session_started" && f.parentSessionId === root)).sessionId,
		);
		const grandchild = String(
			(await nextMatching(client, f => f.type === "session_started" && f.parentSessionId === child)).sessionId,
		);
		await client.request({ version: 2, id: "t1", type: "terminate_session", sessionId: root });

		const terminated: string[] = [];
		while (!terminated.includes(root)) {
			const frame = await client.next(10_000);
			if (frame.type === "session_terminated") terminated.push(String(frame.sessionId));
		}
		expect(terminated).toEqual([grandchild, child, root]);
	}, 30_000);

	it("routes a grandchild's question to a decision carrying the grandchild's handle, and answering continues it", async () => {
		const mock = treeMock(context =>
			lastRole(context) === "toolResult"
				? { content: ["grandchild answered"] }
				: {
						content: [
							{
								type: "toolCall",
								name: "ask",
								arguments: {
									questions: [
										{ id: "q1", question: "Which way?", options: [{ label: "Alpha" }, { label: "Beta" }] },
									],
								},
							},
						],
					},
		);
		const { client, workspace } = await setup(mock);
		const root = await createSessionFor(client, workspace);
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });
		const child = String(
			(await nextMatching(client, f => f.type === "session_started" && f.parentSessionId === root)).sessionId,
		);
		const grandchild = String(
			(await nextMatching(client, f => f.type === "session_started" && f.parentSessionId === child)).sessionId,
		);
		const asked = await nextMatching(client, f => f.type === "decision_requested");
		expect(asked).toMatchObject({ sessionId: grandchild, parentSessionId: child });
		const answer = await client.request({
			version: 2,
			id: "a1",
			type: "answer_decision",
			decisionId: asked.decisionId,
			optionId: "0",
		});
		expect(answer.type).toBe("ack");
		expect(
			await nextMatching(client, f => f.type === "session_completed" && f.sessionId === grandchild),
		).toMatchObject({
			output: "grandchild answered",
		});
	});
});
