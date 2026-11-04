import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import {
	connectClient,
	createMockSessionFactory,
	createSessionFor,
	handshake,
	type MockSessionFactory,
	startDaemonWith,
	startTestDaemon,
	staticCatalog,
	type TestClient,
	type TestDaemon,
	upgradeStatus,
} from "./harness";

const POLL_MS = 20;
const TOKEN_A = "rotation-token-a-for-tests";
const TOKEN_B = "rotation-token-b-for-tests";
const TASK_REF = "00000000-0000-4000-8000-0000000000aa";

const cleanups: Array<() => Promise<void>> = [];
const dirs: TempDir[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const dir of dirs.splice(0)) await dir.remove();
});

function bearer(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

/** Replace a file the way an operator should: write a temp file, then rename it over the target. */
async function replaceCredential(file: string, value: string, mode = 0o600): Promise<void> {
	const temp = `${file}.next`;
	await Bun.write(temp, `${value}\n`);
	await fs.chmod(temp, mode);
	await fs.rename(temp, file);
}

/** Poll until `check` holds; the rotation poll is 20 ms, so a second is generous. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition was not reached in time");
		await Bun.sleep(10);
	}
}

async function tokenFileIn(label: string, token: string): Promise<{ file: string }> {
	const dir = TempDir.createSync(`@control-rotation-${label}-`);
	dirs.push(dir);
	const file = path.join(dir.path(), "control.token");
	await replaceCredential(file, token);
	return { file };
}

/** A daemon whose bearer principal reads `file` and nothing else (no fixed bearer, no control key). */
async function startFileDaemon(file: string): Promise<TestDaemon> {
	const daemon = await startTestDaemon({
		bearerToken: undefined,
		controlKey: undefined,
		credentialFiles: { bearerTokenFile: file },
		credentialPollMs: POLL_MS,
	});
	cleanups.push(() => daemon.close());
	return daemon;
}

describe("control credential rotation", () => {
	it("refuses the old token and accepts the new one within a poll interval after the file is replaced", async () => {
		const { file } = await tokenFileIn("replace", TOKEN_A);
		const daemon = await startFileDaemon(file);
		expect(await upgradeStatus(daemon.url, bearer(TOKEN_A))).toBe(101);

		await replaceCredential(file, TOKEN_B);

		await eventually(async () => (await upgradeStatus(daemon.url, bearer(TOKEN_B))) === 101);
		expect(await upgradeStatus(daemon.url, bearer(TOKEN_A))).toBe(401);
	});

	it("keeps an authenticated connection working across the rotation", async () => {
		const { file } = await tokenFileIn("live", TOKEN_A);
		const daemon = await startFileDaemon(file);
		const client = await connectClient(daemon.url, bearer(TOKEN_A));
		clients.push(client);
		expect(await handshake(client)).toMatchObject({ type: "welcome" });

		await replaceCredential(file, TOKEN_B);
		await eventually(async () => (await upgradeStatus(daemon.url, bearer(TOKEN_A))) === 401);

		const ack = await client.request({ version: 2, id: "sub-after-rotation", type: "subscribe_events" });
		expect(ack).toMatchObject({ type: "ack", inReplyTo: "sub-after-rotation" });
	});

	it("revokes the principal when its file is deleted or made readable by others, logging the path and never the token", async () => {
		const { file } = await tokenFileIn("revoke", TOKEN_A);
		const daemon = await startFileDaemon(file);
		await replaceCredential(file, TOKEN_B);
		await eventually(async () => (await upgradeStatus(daemon.url, bearer(TOKEN_B))) === 101);

		const warnings = spyOn(logger, "warn");
		try {
			await fs.rm(file);
			await eventually(async () => (await upgradeStatus(daemon.url, bearer(TOKEN_B))) === 401);

			await replaceCredential(file, TOKEN_B, 0o644);
			// The credential was already refused while the file was missing, so a 401 straight away proves nothing:
			// wait until the poll has read the unreadable-by-others file and refused it for its mode.
			await eventually(async () => JSON.stringify(warnings.mock.calls).includes("0644"));
			expect(await upgradeStatus(daemon.url, bearer(TOKEN_B))).toBe(401);

			const logged = JSON.stringify(warnings.mock.calls);
			expect(logged).toContain(file);
			expect(logged).not.toContain(TOKEN_B);
		} finally {
			warnings.mockRestore();
		}

		await replaceCredential(file, TOKEN_B);
		await eventually(async () => (await upgradeStatus(daemon.url, bearer(TOKEN_B))) === 101);
	});

	it("reclaims a session created on the old token when a reconnect arrives with the new one", async () => {
		const { file } = await tokenFileIn("reclaim", TOKEN_A);
		const dir = TempDir.createSync("@control-rotation-workspace-");
		dirs.push(dir);
		const mock = createMockModel({ provider: "mock", id: "model-a", responses: [{ content: ["done"] }] });
		const factory: MockSessionFactory = await createMockSessionFactory(mock);
		cleanups.push(() => factory.cleanup());
		const started = await startDaemonWith({
			catalog: staticCatalog([mock.model], []),
			createSession: factory.factory,
			daemonCwd: dir.path(),
			server: {
				bearerToken: undefined,
				controlKey: undefined,
				credentialFiles: { bearerTokenFile: file },
				credentialPollMs: POLL_MS,
			},
		});
		cleanups.push(() => started.dispose());

		const before = await connectClient(started.server.url, bearer(TOKEN_A));
		clients.push(before);
		await handshake(before);
		await before.request({ version: 2, id: "sub-a", type: "subscribe_events" });
		const sessionId = await createSessionFor(before, dir.path());
		before.close();

		await replaceCredential(file, TOKEN_B);
		await eventually(async () => (await upgradeStatus(started.server.url, bearer(TOKEN_B))) === 101);

		const successor = await connectClient(started.server.url, bearer(TOKEN_B));
		clients.push(successor);
		await handshake(successor);
		await successor.request({ version: 2, id: "sub-b", type: "subscribe_events" });
		const reconciled = await successor.request({
			version: 2,
			id: "reconnect-b",
			type: "reconnect",
			activeSessions: [{ sessionId, taskRef: TASK_REF }],
		});
		const [entry] = reconciled.sessions as Array<Record<string, unknown>>;
		expect(entry).toMatchObject({ sessionId, status: "retained_idle" });
	});
});
