import { afterEach, describe, expect, it } from "bun:test";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { logger } from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createMockSessionFactory,
	createSessionFor,
	type MockSessionFactory,
	openSubscribedClient,
	type TestClient,
} from "./harness";

interface EndpointCall {
	body: unknown;
	authorization: string | null;
}

const cleanups: Array<() => Promise<void>> = [];
const dirs: TempDir[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const dir of dirs.splice(0)) await dir.remove();
});

/** A loopback endpoint that records every call and answers with `respond`. */
function startEndpoint(respond: (request: Request, body: string) => Response): { url: string; calls: EndpointCall[] } {
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
			return respond(request, text);
		},
	});
	cleanups.push(async () => {
		await server.stop(true);
	});
	return { url: `http://127.0.0.1:${server.port}`, calls };
}

const LOOKUP_TOKEN = "tool-token-for-tests-9f2";

function lookupBinding(url: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "lookup",
		description: "Look up a record by id",
		endpointUrl: `${url}/lookup`,
		authToken: LOOKUP_TOKEN,
		schema: {
			type: "object",
			properties: { id: { type: "integer" } },
			required: ["id"],
			additionalProperties: false,
		},
		...overrides,
	};
}

async function setup(
	mock: MockModel,
): Promise<{ client: TestClient; factory: MockSessionFactory; workspace: TempDir }> {
	const dir = TempDir.createSync("@control-tools-");
	dirs.push(dir);
	const factory = await createMockSessionFactory(mock);
	const opened = await openSubscribedClient({ mock, workspace: dir.path(), factory: factory.factory });
	cleanups.push(() => opened.dispose());
	cleanups.push(() => factory.cleanup());
	return { client: opened.client, factory, workspace: dir };
}

function promptFrame(id: string, sessionId: string, prompt: string, tools?: unknown[]): Record<string, unknown> {
	return tools === undefined
		? { version: 2, id, type: "prompt_session", sessionId, prompt }
		: { version: 2, id, type: "prompt_session", sessionId, prompt, tools };
}

function lookupCall(id: number) {
	return { content: [{ type: "toolCall" as const, name: "lookup", arguments: { id } }] };
}

describe("control tool bindings", () => {
	it("lets the model call a bound tool, POSTing its JSON input with the bearer token", async () => {
		const endpoint = startEndpoint(() => Response.json({ found: true }));
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [lookupCall(7), { content: ["done"] }],
		});
		const { client, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace.path(), { tools: [lookupBinding(endpoint.url)] });

		expect((await client.request(promptFrame("p1", sessionId, "find seven"))).type).toBe("ack");
		expect((await client.next()).type).toBe("session_started");
		expect(await client.next()).toMatchObject({ type: "session_completed", output: "done" });
		expect(endpoint.calls).toEqual([{ body: { id: 7 }, authorization: `Bearer ${LOOKUP_TOKEN}` }]);
	});

	it("rejects a malformed binding set with invalid_message and keeps the previous set working", async () => {
		const endpoint = startEndpoint(() => Response.json({ found: true }));
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [lookupCall(3), { content: ["done"] }],
		});
		const { client, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace.path(), { tools: [lookupBinding(endpoint.url)] });

		const broken = await client.request(
			promptFrame("bad", sessionId, "x", [
				lookupBinding(endpoint.url),
				lookupBinding(endpoint.url, { endpointUrl: "ftp://nope" }),
			]),
		);
		expect(broken.code).toBe("invalid_message");
		expect(JSON.stringify(broken)).not.toContain(LOOKUP_TOKEN);

		expect((await client.request(promptFrame("p1", sessionId, "find three"))).type).toBe("ack");
		expect((await client.next()).type).toBe("session_started");
		expect((await client.next()).type).toBe("session_completed");
		expect(endpoint.calls).toHaveLength(1);
	});

	it("removes every tool when an idle prompt sends an empty set, so the model's call fails as unknown", async () => {
		const endpoint = startEndpoint(() => Response.json({ found: true }));
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ content: ["cleared"] }, lookupCall(1), { content: ["after clear"] }],
		});
		const { client, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace.path(), { tools: [lookupBinding(endpoint.url)] });

		expect((await client.request(promptFrame("clear", sessionId, "clear tools", []))).type).toBe("ack");
		expect((await client.next()).type).toBe("session_started");
		expect((await client.next()).type).toBe("session_completed");

		expect((await client.request(promptFrame("p2", sessionId, "try lookup"))).type).toBe("ack");
		expect((await client.next()).type).toBe("session_started");
		expect(await client.next()).toMatchObject({ type: "session_completed", output: "after clear" });
		expect(endpoint.calls).toHaveLength(0);
	});

	it("refuses a tool replacement during an active turn and leaves the bindings working", async () => {
		const endpoint = startEndpoint(() => Response.json({ found: true }));
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [{ ...lookupCall(5), delayMs: 300 }, { content: ["done"] }],
		});
		const { client, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace.path(), { tools: [lookupBinding(endpoint.url)] });

		expect((await client.request(promptFrame("p1", sessionId, "find five"))).type).toBe("ack");
		expect((await client.next()).type).toBe("session_started");
		while (mock.calls.length === 0) await Bun.sleep(5);
		const refused = await client.request(promptFrame("p2", sessionId, "change tools", []));
		expect(refused.code).toBe("invalid_message");

		expect(await client.next()).toMatchObject({ type: "session_completed", output: "done" });
		expect(endpoint.calls).toEqual([{ body: { id: 5 }, authorization: `Bearer ${LOOKUP_TOKEN}` }]);
	});

	it("keeps a failing endpoint's error and an echoed token out of frames, logs and the model's next request", async () => {
		const endpoint = startEndpoint((request, body) => {
			const echoed = `${request.headers.get("authorization")} ${body}`;
			return new Response(`internal failure ${echoed}`, { status: 500 });
		});
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [lookupCall(9), { content: ["handled"] }],
		});
		const { client, workspace } = await setup(mock);
		const captured: string[] = [];
		const dispose = logger.registerLogSink(event => captured.push(JSON.stringify(event)));
		cleanups.push(async () => dispose());
		const sessionId = await createSessionFor(client, workspace.path(), { tools: [lookupBinding(endpoint.url)] });

		await client.request(promptFrame("p1", sessionId, "find nine"));
		expect((await client.next()).type).toBe("session_started");
		expect(await client.next()).toMatchObject({ type: "session_completed", output: "handled" });

		const everything = `${captured.join("\n")}\n${JSON.stringify(mock.calls.map(call => call.context))}`;
		expect(everything).not.toContain(LOOKUP_TOKEN);
		expect(everything).toContain("HTTP 500");
	});

	it("redacts an echoed token from a successful tool result before the model sees it", async () => {
		const endpoint = startEndpoint((request, body) => {
			return new Response(`echo ${request.headers.get("authorization")} ${body}`);
		});
		const mock = createMockModel({
			provider: "mock",
			id: "model-a",
			responses: [lookupCall(4), { content: ["seen"] }],
		});
		const { client, workspace } = await setup(mock);
		const sessionId = await createSessionFor(client, workspace.path(), { tools: [lookupBinding(endpoint.url)] });

		await client.request(promptFrame("p1", sessionId, "find four"));
		expect((await client.next()).type).toBe("session_started");
		expect(await client.next()).toMatchObject({ type: "session_completed", output: "seen" });
		const modelSaw = JSON.stringify(mock.calls[1].context.messages);
		expect(modelSaw).toContain("[redacted]");
		expect(modelSaw).not.toContain(LOOKUP_TOKEN);
	});
});
