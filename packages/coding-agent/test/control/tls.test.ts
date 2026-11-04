import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { bindPolicy, type ControlServerHandle, startControlServer } from "../../src/modes/control/control-server";
import { BEARER_TOKEN, handshake, TestClient, upgradeStatus } from "./harness";

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "tls");
const CERT_FILE = path.join(FIXTURE_DIR, "cert.pem");
const KEY_FIXTURE = path.join(FIXTURE_DIR, "key.pem");

const cleanups: Array<() => Promise<void>> = [];
const dirs: TempDir[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const dir of dirs.splice(0)) await dir.remove();
});

/** The fixture key copied to a temp directory with mode 0600: git does not keep that mode. */
async function ownerOnlyKey(): Promise<string> {
	const dir = TempDir.createSync("@control-tls-key-");
	dirs.push(dir);
	const keyFile = path.join(dir.path(), "key.pem");
	await Bun.write(keyFile, await Bun.file(KEY_FIXTURE).text());
	await fs.chmod(keyFile, 0o600);
	return keyFile;
}

async function startTlsServer(): Promise<ControlServerHandle> {
	const handle = await startControlServer({
		bearerToken: BEARER_TOKEN,
		tls: { certFile: CERT_FILE, keyFile: await ownerOnlyKey() },
		timing: { helloTimeoutMs: 500, pingIntervalMs: 50, livenessTimeoutMs: 300 },
	});
	cleanups.push(() => handle.close());
	return handle;
}

function openWebSocket(
	url: string,
	options: { headers: Record<string, string>; tls?: { ca: string } },
): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const socket = new WebSocket(url, options);
	socket.addEventListener("open", () => resolve(socket));
	socket.addEventListener("error", () => reject(new Error("TLS websocket did not open")));
	return promise;
}

describe("control daemon over TLS", () => {
	it("announces a wss URL and completes hello and welcome for a client that trusts the certificate", async () => {
		const handle = await startTlsServer();
		expect(handle.url).toMatch(/^wss:\/\/127\.0\.0\.1:\d+\/control$/);

		const socket = await openWebSocket(handle.url, {
			headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
			tls: { ca: await Bun.file(CERT_FILE).text() },
		});
		const client = new TestClient(socket);
		try {
			expect(await handshake(client)).toMatchObject({ type: "welcome", selectedVersion: 2 });
		} finally {
			client.close();
		}
	});

	it("never completes a plaintext upgrade on the TLS listener", async () => {
		const handle = await startTlsServer();
		const plaintextUrl = handle.url.replace(/^wss:/, "ws:");
		// A TLS server answers a plaintext request with a TLS alert and closes, so no HTTP status line arrives.
		const outcome = await upgradeStatus(plaintextUrl, { Authorization: `Bearer ${BEARER_TOKEN}` }).catch(
			() => "no HTTP status",
		);
		expect(outcome).not.toBe(101);
	});

	it("refuses a client that does not trust the certificate", async () => {
		const handle = await startTlsServer();
		await expect(openWebSocket(handle.url, { headers: { Authorization: `Bearer ${BEARER_TOKEN}` } })).rejects.toThrow(
			"TLS websocket did not open",
		);
	});

	it("refuses to start with TLS on a wildcard address, because its URL cannot be dialed or certified", async () => {
		await expect(
			startControlServer({
				bearerToken: BEARER_TOKEN,
				hostname: "0.0.0.0",
				port: 0,
				tls: { certFile: CERT_FILE, keyFile: await ownerOnlyKey() },
			}),
		).rejects.toThrow(/wildcard/);
	});

	it("refuses to listen with a TLS key that other accounts can read, naming the file but not its bytes", async () => {
		const keyFile = await ownerOnlyKey();
		await fs.chmod(keyFile, 0o644);
		const error = await startControlServer({
			bearerToken: BEARER_TOKEN,
			tls: { certFile: CERT_FILE, keyFile },
		}).then(
			handle => {
				cleanups.push(() => handle.close());
				return undefined;
			},
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain(keyFile);
		expect(message).toContain("0644");
		expect(message).not.toContain("PRIVATE KEY");
	});

	it("refuses a numeric spelling of the wildcard address too, rather than listening on every interface", async () => {
		await expect(
			startControlServer({
				bearerToken: BEARER_TOKEN,
				hostname: "0",
				port: 0,
				tls: { certFile: CERT_FILE, keyFile: await ownerOnlyKey() },
			}),
		).rejects.toThrow(/wildcard/);
	});
});

describe("bindPolicy", () => {
	it.each([
		{ host: "127.0.0.1", tls: false, refused: false },
		{ host: "::1", tls: false, refused: false },
		{ host: "127.0.0.1", tls: true, refused: false },
		{ host: "192.0.2.10", tls: false, refused: true },
		{ host: "192.0.2.10", tls: true, refused: false },
		{ host: "0.0.0.0", tls: false, refused: true },
		{ host: "0.0.0.0", tls: true, refused: true },
		{ host: "::", tls: true, refused: true },
		// Other spellings of the same wildcard addresses: the listener binds every interface for each of these.
		{ host: "0", tls: true, refused: true },
		{ host: "0.0", tls: true, refused: true },
		{ host: "0x0", tls: true, refused: true },
		{ host: "::0", tls: true, refused: true },
		{ host: "0:0:0:0:0:0:0:0", tls: true, refused: true },
		{ host: "::ffff:0.0.0.0", tls: true, refused: true },
		{ host: "10.0.0.5", tls: true, refused: false },
		{ host: "fd00::5", tls: true, refused: false },
		{ host: "daemon.example.net", tls: true, refused: false },
	])("host $host with tls=$tls is refused: $refused", ({ host, tls, refused }) => {
		expect(bindPolicy(host, tls) !== undefined).toBe(refused);
	});
});
