import { afterEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import { logger } from "@oh-my-pi/pi-utils";
import { startControlServer } from "@oh-my-pi/pi-coding-agent/modes/control/control-server";
import {
	BEARER_TOKEN,
	CONTROL_KEY,
	connectClient,
	handshake,
	maskedTextFrame,
	readCloseCode,
	silentUpgradedSocket,
	startTestDaemon,
	subscribe,
	type TestClient,
	type TestDaemon,
	upgradeStatus,
} from "./harness";

let daemon: TestDaemon | undefined;
const clients: TestClient[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const socket of sockets.splice(0)) socket.destroy();
	await daemon?.close();
	daemon = undefined;
});

async function start(options: Parameters<typeof startTestDaemon>[0] = {}): Promise<TestDaemon> {
	daemon = await startTestDaemon(options);
	return daemon;
}

async function open(url: string, headers: Record<string, string>): Promise<TestClient> {
	const client = await connectClient(url, headers);
	clients.push(client);
	return client;
}

describe("control front door: credentials", () => {
	it("refuses missing, doubled, wrong and query-string credentials with 401 and no upgrade", async () => {
		const server = await start();
		const url = server.url;
		expect(await upgradeStatus(url, {})).toBe(401);
		expect(await upgradeStatus(url, { ...server.bearerHeaders, ...server.keyHeaders })).toBe(401);
		expect(await upgradeStatus(url, { Authorization: "Bearer not-the-token" })).toBe(401);
		expect(await upgradeStatus(url, { "X-Omp-Control-Key": "not-the-key" })).toBe(401);
		expect(await upgradeStatus(`${url}?token=${BEARER_TOKEN}`, server.bearerHeaders)).toBe(401);
		expect(await upgradeStatus(`${url}?key=${CONTROL_KEY}`, server.keyHeaders)).toBe(401);
		expect(await upgradeStatus(`${url}?access_token=${BEARER_TOKEN}`, server.bearerHeaders)).toBe(401);
	});

	it("upgrades with either credential and handshakes as that principal", async () => {
		const server = await start();
		const viaBearer = await open(server.url, server.bearerHeaders);
		expect(await handshake(viaBearer)).toEqual({
			version: 2,
			inReplyTo: "hello-1",
			type: "welcome",
			selectedVersion: 2,
		});
		const viaKey = await open(server.url, server.keyHeaders);
		expect(await handshake(viaKey)).toEqual({
			version: 2,
			inReplyTo: "hello-1",
			type: "welcome",
			selectedVersion: 2,
		});
	});

	it("never writes a credential to the log or to any frame", async () => {
		const server = await start();
		const captured: string[] = [];
		const dispose = logger.registerLogSink(event => captured.push(JSON.stringify(event)));
		try {
			await upgradeStatus(server.url, { Authorization: "Bearer wrong-value-that-must-not-leak" });
			const bearer = await open(server.url, server.bearerHeaders);
			const key = await open(server.url, server.keyHeaders);
			const frames = [await handshake(bearer), await handshake(key)];
			bearer.sendText("{not json");
			frames.push(await bearer.next());
			captured.push(JSON.stringify(frames));
		} finally {
			dispose();
		}
		const all = captured.join("\n");
		expect(all).not.toContain(BEARER_TOKEN);
		expect(all).not.toContain(CONTROL_KEY);
		expect(all).not.toContain("wrong-value-that-must-not-leak");
	});

	it("refuses to start without a credential or with a blank one", async () => {
		await expect(startControlServer({})).rejects.toThrow(/bearer token or a control key/);
		await expect(startControlServer({ bearerToken: "   " })).rejects.toThrow(/must not be blank/);
	});

	it("refuses to bind a non-loopback address", async () => {
		await expect(startControlServer({ bearerToken: BEARER_TOKEN, hostname: "0.0.0.0", port: 0 })).rejects.toThrow(
			/non-loopback/,
		);
	});
});

describe("control front door: handshake", () => {
	it("answers a command sent before hello with handshake_required and no side effect", async () => {
		const server = await start();
		const client = await open(server.url, server.bearerHeaders);
		const reply = await client.request({ version: 2, id: "early", type: "query_capabilities" });
		expect(reply).toEqual({
			version: 2,
			inReplyTo: "early",
			type: "error",
			code: "handshake_required",
			message: expect.any(String),
		});
	});

	it("rejects a proposal with no common version with version_mismatch and closes 1002", async () => {
		const server = await start();
		const client = await open(server.url, server.bearerHeaders);
		client.send({ version: 2, id: "bad-version", type: "hello", supportedVersions: [3] });
		const reply = await client.replyTo("bad-version");
		expect(reply.code).toBe("version_mismatch");
		expect((await client.closedWithin()).code).toBe(1002);
	});

	it("rejects a malformed proposal with invalid_message and keeps the socket open", async () => {
		const server = await start();
		const client = await open(server.url, server.bearerHeaders);
		for (const [id, supportedVersions] of [
			["empty", []],
			["duplicate", [2, 2]],
			["non-integer", ["2"]],
		] as const) {
			const reply = await client.request({ version: 2, id, type: "hello", supportedVersions });
			expect(reply.code).toBe("invalid_message");
		}
		expect(await handshake(client)).toMatchObject({ type: "welcome", selectedVersion: 2 });
	});

	it("answers a second hello with unsupported_operation", async () => {
		const server = await start();
		const client = await open(server.url, server.bearerHeaders);
		await handshake(client);
		const reply = await client.request({ version: 2, id: "hello-2", type: "hello", supportedVersions: [2] });
		expect(reply.code).toBe("unsupported_operation");
	});

	it("closes 1008 when no hello arrives within helloTimeoutMs", async () => {
		const server = await start({ timing: { helloTimeoutMs: 80 } });
		const client = await open(server.url, server.bearerHeaders);
		expect((await client.closedWithin()).code).toBe(1008);
	});
});

describe("control front door: envelope", () => {
	it("rejects a reused command id without running the command a second time", async () => {
		const server = await start();
		const client = await open(server.url, server.bearerHeaders);
		await handshake(client);
		const first = await client.request({ version: 2, id: "cap", type: "query_capabilities" });
		expect(first.type).toBe("capabilities");
		client.send({ version: 2, id: "cap", type: "query_capabilities" });
		const second = await client.replyTo("cap");
		expect(second.code).toBe("invalid_message");
	});

	it("reports malformed JSON as an uncorrelated invalid_message", async () => {
		const server = await start();
		const client = await open(server.url, server.bearerHeaders);
		client.sendText("{");
		const reply = await client.next();
		expect(reply).toEqual({ version: 2, type: "error", code: "invalid_message", message: expect.any(String) });
	});

	it("rejects a foreign envelope version after negotiation with version_mismatch", async () => {
		const server = await start();
		const client = await open(server.url, server.bearerHeaders);
		await handshake(client);
		const reply = await client.request({ version: 3, id: "v3", type: "query_capabilities" });
		expect(reply.code).toBe("version_mismatch");
	});

	it("ignores unknown additive fields", async () => {
		const server = await start();
		const client = await open(server.url, server.bearerHeaders);
		await handshake(client);
		const ack = await subscribe(client);
		expect(ack).toEqual({ version: 2, inReplyTo: "sub-1", type: "ack" });
		const extra = await client.request({ version: 2, id: "extra", type: "query_capabilities", note: "ignored" });
		expect(extra.type).toBe("capabilities");
	});

	it("acknowledges a repeated subscribe_events without changing the connection", async () => {
		const server = await start();
		const client = await open(server.url, server.bearerHeaders);
		await handshake(client);
		await subscribe(client, "sub-a");
		expect(await subscribe(client, "sub-b")).toEqual({ version: 2, inReplyTo: "sub-b", type: "ack" });
	});

	it("advertises exactly the features built so far", async () => {
		const server = await start();
		const client = await open(server.url, server.bearerHeaders);
		await handshake(client);
		expect(await client.request({ version: 2, id: "caps", type: "query_capabilities" })).toEqual({
			version: 2,
			inReplyTo: "caps",
			type: "capabilities",
			features: ["catalog", "steering", "usage", "interrupt", "terminate"],
		});
	});
});

describe("control front door: frames and transport", () => {
	it("closes 1003 on a binary message", async () => {
		const server = await start();
		const client = await open(server.url, server.bearerHeaders);
		await handshake(client);
		client.sendBinary(new Uint8Array([1, 2, 3]));
		expect((await client.closedWithin()).code).toBe(1003);
	});

	it("closes 1009 on a message above 16 MiB", async () => {
		const server = await start();
		const client = await open(server.url, server.bearerHeaders);
		await handshake(client);
		client.sendText("x".repeat(16 * 1024 * 1024 + 1));
		expect((await client.closedWithin(5_000)).code).toBe(1009);
	});

	it("closes 1007 on invalid UTF-8 in a text frame", async () => {
		const server = await start();
		const socket = await silentUpgradedSocket(server.url, server.bearerHeaders);
		sockets.push(socket);
		socket.write(maskedTextFrame(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])));
		expect(await readCloseCode(socket)).toBe(1007);
	});

	it("closes a peer that never answers pings after livenessTimeoutMs", async () => {
		const server = await start({ timing: { pingIntervalMs: 40, livenessTimeoutMs: 150 } });
		const socket = await silentUpgradedSocket(server.url, server.bearerHeaders);
		sockets.push(socket);
		const closed = Promise.withResolvers<void>();
		socket.on("close", () => closed.resolve());
		socket.on("error", () => closed.resolve());
		socket.resume();
		await closed.promise;
	});

	it("keeps a responsive client alive across several ping intervals", async () => {
		const server = await start({ timing: { pingIntervalMs: 40, livenessTimeoutMs: 150 } });
		const client = await open(server.url, server.bearerHeaders);
		await handshake(client);
		await Bun.sleep(400);
		const reply = await client.request({ version: 2, id: "still-here", type: "query_capabilities" });
		expect(reply.type).toBe("capabilities");
	});
});
