import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	connectClient,
	createMockSessionFactory,
	handshake,
	type MockSessionFactory,
	startDaemonWith,
	staticCatalog,
	subscribe,
	type TestClient,
} from "./harness";

const AGENT_PROMPT = "AGENT_PROMPT_MARKER: review the diff carefully";

const agents: AgentDefinition[] = [
	{
		name: "implementer",
		description: "Implementation agent",
		systemPrompt: AGENT_PROMPT,
		model: ["mock/model-a"],
		source: "bundled",
		filePath: "/private/agents/implementer.md",
	},
	{
		name: "reviewer",
		description: "Unpinned reviewer",
		systemPrompt: "reviewer prompt",
		model: ["no-such-model"],
		source: "bundled",
	},
];

const cleanups: Array<() => Promise<void>> = [];
const clients: TestClient[] = [];
let tempDir: TempDir | undefined;

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await tempDir?.remove();
	tempDir = undefined;
});

async function startWith(mock: MockModel, factory: MockSessionFactory, workspace: string) {
	const daemon = await startDaemonWith({
		catalog: staticCatalog([mock.model], agents),
		createSession: factory.factory,
		daemonCwd: workspace,
	});
	cleanups.push(() => daemon.dispose());
	cleanups.push(() => factory.cleanup());
	const client = await connectClient(daemon.server.url, daemon.server.bearerHeaders);
	clients.push(client);
	await handshake(client);
	return client;
}

function makeMock(): MockModel {
	return createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["ready"] }] });
}

describe("control catalog", () => {
	it("lists models as provider/id and agents without prompt text or definition paths", async () => {
		tempDir = TempDir.createSync("@control-catalog-");
		const mock = makeMock();
		const factory = await createMockSessionFactory(mock);
		const client = await startWith(mock, factory, tempDir.path());

		const catalog = await client.request({ version: 2, id: "cat", type: "query_catalog" });
		expect(catalog.type).toBe("catalog");
		expect(catalog.models).toEqual([{ id: "mock/model-a", provider: "mock" }]);
		expect(catalog.agents).toEqual([
			{ name: "implementer", description: "Implementation agent", roles: [], defaultModel: "mock/model-a" },
			{ name: "reviewer", description: "Unpinned reviewer", roles: [] },
		]);
		expect(JSON.stringify(catalog)).not.toContain("AGENT_PROMPT_MARKER");
		expect(JSON.stringify(catalog)).not.toContain("/private/agents");
	});
});

describe("control create_session", () => {
	it("creates a session that runs the named agent's system prompt on the mock model", async () => {
		tempDir = TempDir.createSync("@control-agent-prompt-");
		const mock = makeMock();
		const factory = await createMockSessionFactory(mock);
		const client = await startWith(mock, factory, tempDir.path());
		await subscribe(client);

		const created = await client.request({
			version: 2,
			id: "create",
			type: "create_session",
			workspacePath: tempDir.path(),
			taskRef: "00000000-0000-4000-8000-000000000001",
			agent: "implementer",
			model: "mock/model-a",
		});
		expect(created.type).toBe("session_created");
		expect(typeof created.sessionId).toBe("string");

		await factory.sessions[0].prompt("hello");
		expect(JSON.stringify(mock.calls[0].context.systemPrompt)).toContain("AGENT_PROMPT_MARKER");
		expect(factory.requests[0].model?.id).toBe("model-a");
	});

	it("rejects a relative, missing, file or unreadable workspace with invalid_workspace and creates nothing", async () => {
		tempDir = TempDir.createSync("@control-workspace-");
		const mock = makeMock();
		const factory = await createMockSessionFactory(mock);
		const client = await startWith(mock, factory, tempDir.path());
		await subscribe(client);
		const filePath = path.join(tempDir.path(), "plain-file");
		await Bun.write(filePath, "not a directory");
		const unreadable = path.join(tempDir.path(), "unreadable");
		await fs.mkdir(unreadable);
		const access = spyOn(fs, "access").mockImplementation(async target => {
			if (String(target) === unreadable) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		});
		cleanups.push(async () => access.mockRestore());

		const workspaces = ["relative/dir", path.join(tempDir.path(), "missing"), filePath, unreadable];
		for (const [index, workspacePath] of workspaces.entries()) {
			const reply = await client.request({
				version: 2,
				id: `bad-${index}`,
				type: "create_session",
				workspacePath,
				taskRef: "00000000-0000-4000-8000-000000000002",
			});
			expect(reply.code).toBe("invalid_workspace");
		}
		expect(factory.requests).toHaveLength(0);
	});

	it("answers an unknown agent or model with a typed error and creates nothing", async () => {
		tempDir = TempDir.createSync("@control-unknown-");
		const mock = makeMock();
		const factory = await createMockSessionFactory(mock);
		const client = await startWith(mock, factory, tempDir.path());
		await subscribe(client);
		const base = {
			version: 2,
			type: "create_session",
			workspacePath: tempDir.path(),
			taskRef: "00000000-0000-4000-8000-000000000003",
		};

		const agentReply = await client.request({ ...base, id: "agent", agent: "ghost" });
		expect(agentReply.code).toBe("unknown_agent");
		const modelReply = await client.request({ ...base, id: "model", model: "mock/ghost" });
		expect(modelReply.code).toBe("unknown_model");
		expect(factory.requests).toHaveLength(0);
	});

	it("refuses create_session before subscribe_events with unsupported_operation and creates nothing", async () => {
		tempDir = TempDir.createSync("@control-subscribe-");
		const mock = makeMock();
		const factory = await createMockSessionFactory(mock);
		const client = await startWith(mock, factory, tempDir.path());
		const reply = await client.request({
			version: 2,
			id: "early-create",
			type: "create_session",
			workspacePath: tempDir.path(),
			taskRef: "00000000-0000-4000-8000-000000000004",
		});
		expect(reply.code).toBe("unsupported_operation");
		expect(factory.requests).toHaveLength(0);
	});

	it("rejects a malformed taskRef with invalid_message", async () => {
		tempDir = TempDir.createSync("@control-taskref-");
		const mock = makeMock();
		const factory = await createMockSessionFactory(mock);
		const client = await startWith(mock, factory, tempDir.path());
		await subscribe(client);
		const reply = await client.request({
			version: 2,
			id: "bad-task",
			type: "create_session",
			workspacePath: tempDir.path(),
			taskRef: "not-a-uuid",
		});
		expect(reply.code).toBe("invalid_message");
		expect(factory.requests).toHaveLength(0);
	});
});
