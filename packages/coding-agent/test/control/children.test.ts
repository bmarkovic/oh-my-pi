import { afterEach, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
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
const TOOL_TOKEN = "child-tool-token-7c1";

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

function isChildTurn(context: Context): boolean {
	return context.messages.some(message => message.role === "user" && textOf(message).includes("CHILD_TASK"));
}

function lastRole(context: Context): string | undefined {
	return context.messages[context.messages.length - 1]?.role;
}

/**
 * Scripted model: the root spawns one `task` child and finishes after it; the child
 * runs `childStep` on each of its calls.
 */
function scriptedMock(childStep: (context: Context) => MockResponse): MockModel {
	return createMockModel({
		provider: "mock",
		id: "model-a",
		handler: context => {
			if (isChildTurn(context)) return childStep(context);
			if (lastRole(context) === "toolResult") return { content: ["root done"] };
			return {
				content: [
					{
						type: "toolCall",
						name: "task",
						arguments: { agent: "task", task: "CHILD_TASK compute the answer", solutionSpace: "answer only" },
					},
				],
			};
		},
	});
}

async function setup(
	mock: MockModel,
	bindingUrl?: string,
): Promise<{ client: TestClient; factory: MockSessionFactory; workspace: TempDir }> {
	const dir = TempDir.createSync("@control-children-");
	dirs.push(dir);
	const factory = await createMockSessionFactory(mock);
	const opened = await openSubscribedClient({ mock, workspace: dir.path(), factory: factory.factory });
	cleanups.push(() => opened.dispose());
	cleanups.push(() => factory.cleanup());
	return { client: opened.client, factory, workspace: dir };
}

async function nextMatching(
	client: TestClient,
	predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
	for (;;) {
		const frame = await client.next(5_000);
		if (predicate(frame)) return frame;
	}
}

describe("control child lineage", () => {
	it("announces a subagent as a child before its activity and lists it under the root", async () => {
		const mock = scriptedMock(() => ({ content: ["child answer"] }));
		const { client, workspace } = await setup(mock);
		const root = await createSessionFor(client, workspace.path());

		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });
		const childStarted = await nextMatching(
			client,
			frame => frame.type === "session_started" && frame.parentSessionId === root,
		);
		const child = String(childStarted.sessionId);
		const childCompleted = await nextMatching(
			client,
			frame => frame.type === "session_completed" && frame.sessionId === child,
		);
		expect(childCompleted).toMatchObject({ parentSessionId: root, output: "child answer" });
		expect(
			await nextMatching(client, frame => frame.type === "session_completed" && frame.sessionId === root),
		).toMatchObject({
			output: "root done",
		});

		const listed = await client.request({
			version: 2,
			id: "enum",
			type: "enumerate_child_sessions",
			parentSessionId: root,
		});
		expect(listed).toEqual({
			version: 2,
			inReplyTo: "enum",
			type: "child_sessions",
			parentSessionId: root,
			childSessionIds: [child],
		});
	});

	it("refuses prompt, interrupt and terminate on a child with unsupported_operation and leaves it running", async () => {
		const mock = scriptedMock(() => ({ content: ["slow child"], delayMs: 3_000 }));
		const { client, workspace } = await setup(mock);
		const root = await createSessionFor(client, workspace.path());
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });
		const child = String(
			(await nextMatching(client, frame => frame.parentSessionId === root && frame.type === "session_started"))
				.sessionId,
		);

		for (const [id, type] of [
			["cp", "prompt_session"],
			["ci", "interrupt_session"],
			["ct", "terminate_session"],
		] as const) {
			const reply = await client.request({ version: 2, id, type, sessionId: child, prompt: "x" });
			expect(reply.code).toBe("unsupported_operation");
		}
		// The child is still running: its own outcome arrives later, not a stop it never received.
		expect(
			await nextMatching(client, frame => frame.type === "session_completed" && frame.sessionId === child),
		).toMatchObject({
			parentSessionId: root,
		});
		await nextMatching(client, frame => frame.type === "session_completed" && frame.sessionId === root);
	}, 20_000);

	it("interrupts a running child before the root's session_interrupted, and the root accepts a new prompt", async () => {
		const mock = scriptedMock(() => ({ content: ["slow child"], delayMs: 5_000 }));
		const { client, workspace } = await setup(mock);
		const root = await createSessionFor(client, workspace.path());
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });
		const child = String(
			(await nextMatching(client, frame => frame.parentSessionId === root && frame.type === "session_started"))
				.sessionId,
		);

		expect((await client.request({ version: 2, id: "i1", type: "interrupt_session", sessionId: root })).type).toBe(
			"ack",
		);
		const childInterrupted = await nextMatching(
			client,
			frame => frame.type === "session_interrupted" && frame.sessionId === child,
		);
		const rootInterrupted = await nextMatching(
			client,
			frame => frame.type === "session_interrupted" && frame.sessionId === root,
		);
		expect(childInterrupted.parentSessionId).toBe(root);
		expect(rootInterrupted.parentSessionId).toBeUndefined();
	}, 20_000);

	it("terminates children before the root's session_terminated", async () => {
		const mock = scriptedMock(() => ({ content: ["slow child"], delayMs: 5_000 }));
		const { client, workspace } = await setup(mock);
		const root = await createSessionFor(client, workspace.path());
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });
		const child = String(
			(await nextMatching(client, frame => frame.parentSessionId === root && frame.type === "session_started"))
				.sessionId,
		);

		expect((await client.request({ version: 2, id: "t1", type: "terminate_session", sessionId: root })).type).toBe(
			"ack",
		);
		const childTerminated = await nextMatching(
			client,
			frame => frame.type === "session_terminated" && frame.sessionId === child,
		);
		const rootTerminated = await nextMatching(
			client,
			frame => frame.type === "session_terminated" && frame.sessionId === root,
		);
		expect(childTerminated.parentSessionId).toBe(root);
		expect(rootTerminated.parentSessionId).toBeUndefined();
	}, 20_000);

	it("gives the child the root's tool bindings, so its tool call carries the root's token", async () => {
		const received: string[] = [];
		const endpoint = http.createServer((request, response) => {
			received.push(String(request.headers.authorization));
			request.resume();
			request.on("end", () => {
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ found: true }));
			});
		});
		await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", () => resolve()));
		cleanups.push(() => new Promise<void>(resolve => endpoint.close(() => resolve())));
		const port = (endpoint.address() as { port: number }).port;

		const mock = scriptedMock(context =>
			lastRole(context) === "toolResult"
				? { content: ["child used the tool"] }
				: { content: [{ type: "toolCall", name: "lookup", arguments: { id: 2 } }] },
		);
		const dir = TempDir.createSync("@control-children-tool-");
		dirs.push(dir);
		const factory = await createMockSessionFactory(mock);
		const opened = await openSubscribedClient({ mock, workspace: dir.path(), factory: factory.factory });
		cleanups.push(() => opened.dispose());
		cleanups.push(() => factory.cleanup());
		const client = opened.client;
		const root = await createSessionFor(client, dir.path(), {
			tools: [
				{
					name: "lookup",
					description: "Look up",
					endpointUrl: `http://127.0.0.1:${port}/lookup`,
					authToken: TOOL_TOKEN,
					schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
				},
			],
		});

		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });
		expect(
			await nextMatching(client, frame => frame.type === "session_completed" && frame.sessionId === root),
		).toMatchObject({
			output: "root done",
		});
		expect(received).toEqual([`Bearer ${TOOL_TOKEN}`]);
	}, 20_000);

	it("routes a child's question to a decision that names the child and its parent", async () => {
		const mock = scriptedMock(context =>
			lastRole(context) === "toolResult"
				? { content: ["child decided"] }
				: {
						content: [
							{
								type: "toolCall",
								name: "ask",
								arguments: { questions: [{ id: "q1", question: "Which way?", options: [{ label: "Alpha" }] }] },
							},
						],
					},
		);
		const { client, workspace } = await setup(mock);
		const root = await createSessionFor(client, workspace.path());
		await client.request({ version: 2, id: "p1", type: "prompt_session", sessionId: root, prompt: "ROOT_PROMPT" });
		const child = String(
			(await nextMatching(client, frame => frame.parentSessionId === root && frame.type === "session_started"))
				.sessionId,
		);

		const requested = await nextMatching(client, frame => frame.type === "decision_requested");
		expect(requested).toMatchObject({ sessionId: child, parentSessionId: root, question: "Which way?" });
		const answer = await client.request({
			version: 2,
			id: "a1",
			type: "answer_decision",
			decisionId: requested.decisionId,
			optionId: "0",
		});
		expect(answer.type).toBe("ack");
		expect(await nextMatching(client, frame => frame.type === "decision_answered")).toMatchObject({
			sessionId: child,
			parentSessionId: root,
		});
		expect(
			await nextMatching(client, frame => frame.type === "session_completed" && frame.sessionId === root),
		).toMatchObject({
			output: "root done",
		});
	}, 20_000);
});
