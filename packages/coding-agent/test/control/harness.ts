import { spyOn } from "bun:test";
/**
 * Shared harness for the control daemon tests: a real loopback listener, a
 * Bun WebSocket client with a frame queue, and raw-socket helpers for the cases a
 * conforming client cannot produce (unanswered pings, invalid UTF-8 text frames).
 */
import * as net from "node:net";
import type { Model } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ControlCatalogSource,
	type ControlOperationHandler,
	type ControlRetentionTiming,
	ControlDaemon,
	type ControlServerHandle,
	type ControlServerOptions,
	type ControlSessionFactory,
	type ControlSessionRequest,
	sessionOptionsForAgent,
	startControlServer,
} from "@oh-my-pi/pi-coding-agent/modes/control/index";
import { ensureTheme } from "@oh-my-pi/pi-tui/theme";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

export const BEARER_TOKEN = "bearer-credential-for-tests";
export const CONTROL_KEY = "key-credential-for-tests";

export type Frame = Record<string, unknown>;

export interface TestDaemonOptions extends Partial<ControlServerOptions> {
	operations?: ReadonlyMap<string, ControlOperationHandler>;
}

export interface TestDaemon extends ControlServerHandle {
	readonly port: number;
	readonly bearerHeaders: Record<string, string>;
	readonly keyHeaders: Record<string, string>;
}

/** Start a daemon on an ephemeral loopback port with credentials and short deadlines. */
export async function startTestDaemon(options: TestDaemonOptions = {}): Promise<TestDaemon> {
	const handle = await startControlServer({
		bearerToken: BEARER_TOKEN,
		controlKey: CONTROL_KEY,
		...options,
		timing: { helloTimeoutMs: 500, pingIntervalMs: 50, livenessTimeoutMs: 300, ...options.timing },
	});
	const port = Number(new URL(handle.url).port);
	return {
		...handle,
		port,
		bearerHeaders: { Authorization: `Bearer ${BEARER_TOKEN}` },
		keyHeaders: { "X-Omp-Control-Key": CONTROL_KEY },
	};
}

/** A connected test client that queues every inbound frame in arrival order. */
export class TestClient {
	readonly #socket: WebSocket;
	readonly #frames: Frame[] = [];
	readonly #waiters: Array<(frame: Frame) => void> = [];
	readonly #closed = Promise.withResolvers<CloseEvent>();
	#closeEvent: CloseEvent | undefined;

	constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener("message", event => {
			const frame = JSON.parse(String(event.data)) as Frame;
			const waiter = this.#waiters.shift();
			if (waiter) waiter(frame);
			else this.#frames.push(frame);
		});
		socket.addEventListener("close", event => {
			this.#closeEvent = event;
			this.#closed.resolve(event);
		});
	}

	/** Send one JSON command. */
	send(frame: object): void {
		this.#socket.send(JSON.stringify(frame));
	}

	/** Send a binary frame. */
	sendBinary(bytes: Uint8Array): void {
		this.#socket.send(bytes);
	}

	/** Send an arbitrary text payload exactly as given. */
	sendText(text: string): void {
		this.#socket.send(text);
	}

	/** Next inbound frame, waiting up to `timeoutMs`. Rejects on timeout. */
	next(timeoutMs = 2_000): Promise<Frame> {
		const queued = this.#frames.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<Frame>();
		this.#waiters.push(resolve);
		// A waiter that timed out must not stay queued, or it would swallow the next frame.
		return withTimeout(promise, timeoutMs, "timed out waiting for a frame").catch((error: unknown) => {
			const index = this.#waiters.indexOf(resolve);
			if (index >= 0) this.#waiters.splice(index, 1);
			throw error;
		});
	}

	/** The next frame, asserting that it answers `inReplyTo`. */
	async replyTo(id: string): Promise<Frame> {
		const frame = await this.next();
		if (frame.inReplyTo !== id) throw new Error(`expected a reply to ${id}, got ${JSON.stringify(frame)}`);
		return frame;
	}

	/** Resolves with the close event; rejects if the socket stays open past `timeoutMs`. */
	closedWithin(timeoutMs = 2_000): Promise<CloseEvent> {
		if (this.#closeEvent) return Promise.resolve(this.#closeEvent);
		return withTimeout(this.#closed.promise, timeoutMs, "socket stayed open");
	}

	/** Run one command round trip and return its reply. */
	async request(frame: Frame): Promise<Frame> {
		this.send(frame);
		return this.replyTo(String(frame.id));
	}

	close(): void {
		this.#socket.close(1000, "test done");
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: Timer | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Open an authenticated (or deliberately not) WebSocket client. */
export async function connectClient(url: string, headers: Record<string, string>): Promise<TestClient> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const socket = new WebSocket(url, { headers });
	socket.addEventListener("open", () => resolve(socket));
	socket.addEventListener("error", () => reject(new Error("websocket upgrade failed")));
	return new TestClient(await withTimeout(promise, 2_000, "websocket did not open"));
}

/** Perform the hello handshake and return the welcome frame. */
export async function handshake(client: TestClient, id = "hello-1"): Promise<Frame> {
	return client.request({ version: 2, id, type: "hello", supportedVersions: [2] });
}

/** Subscribe the connection and return the ack. */
export async function subscribe(client: TestClient, id = "sub-1"): Promise<Frame> {
	return client.request({ version: 2, id, type: "subscribe_events" });
}

/** Raw HTTP upgrade request; resolves with the status line's code (101 on success). */
export function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
	const { hostname, port, pathname, search } = new URL(url);
	const lines = [
		`GET ${pathname}${search} HTTP/1.1`,
		`Host: ${hostname}:${port}`,
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
		"Sec-WebSocket-Version: 13",
		...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
		"",
		"",
	];
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const socket = net.connect({ host: hostname, port: Number(port) });
	let received = "";
	socket.on("connect", () => socket.write(lines.join("\r\n")));
	socket.on("data", chunk => {
		received += chunk.toString("latin1");
		const match = /^HTTP\/1\.1 (\d{3})/.exec(received);
		if (match) {
			resolve(Number(match[1]));
			socket.destroy();
		}
	});
	socket.on("error", reject);
	socket.on("close", () => reject(new Error("socket closed before a status line")));
	return withTimeout(promise, 2_000, "no HTTP status line");
}

/**
 * Open a socket, upgrade it, and then leave it alone: it never reads or answers
 * pings. Bytes that arrive after the HTTP headers stay readable on the socket.
 */
export async function silentUpgradedSocket(url: string, headers: Record<string, string>): Promise<net.Socket> {
	const { hostname, port, pathname } = new URL(url);
	const socket = net.connect({ host: hostname, port: Number(port) });
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const request = [
		`GET ${pathname} HTTP/1.1`,
		`Host: ${hostname}:${port}`,
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
		"Sec-WebSocket-Version: 13",
		...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
		"",
		"",
	].join("\r\n");
	let buffer = Buffer.alloc(0);
	const onData = (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		socket.off("data", onData);
		socket.pause();
		const rest = buffer.subarray(headerEnd + 4);
		if (rest.length > 0) socket.unshift(rest);
		resolve(socket);
	};
	socket.on("data", onData);
	socket.on("connect", () => socket.write(request));
	socket.on("error", reject);
	return withTimeout(promise, 2_000, "upgrade not answered");
}

/** Build a masked client text frame whose payload is `payload` (may be invalid UTF-8). */
export function maskedTextFrame(payload: Uint8Array): Uint8Array {
	const mask = new Uint8Array([0x37, 0xfa, 0x21, 0x3d]);
	const header: number[] = [0x81];
	if (payload.byteLength < 126) header.push(0x80 | payload.byteLength);
	else if (payload.byteLength <= 0xffff) header.push(0x80 | 126, payload.byteLength >> 8, payload.byteLength & 0xff);
	else throw new Error("payload too large for this helper");
	const body = new Uint8Array(payload.byteLength);
	for (let index = 0; index < payload.byteLength; index++) body[index] = payload[index] ^ mask[index % 4];
	return Uint8Array.from([...header, ...mask, ...body]);
}

/** Read the first server close frame on a raw socket and return its status code. */
export function readCloseCode(socket: net.Socket, timeoutMs = 2_000): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const onData = (chunk: Buffer) => {
		// Server frames are unmasked: FIN+opcode 0x8 (close), a length byte, then the status code.
		const index = chunk.indexOf(0x88);
		if (index < 0 || index + 4 > chunk.length) return;
		resolve(chunk.readUInt16BE(index + 2));
		socket.off("data", onData);
	};
	socket.on("data", onData);
	socket.on("close", () => reject(new Error("socket closed without a close frame")));
	socket.resume();
	return withTimeout(promise, timeoutMs, "no close frame");
}

/** A session factory that builds real sessions through `createAgentSession`, driven by one mock model. */
export interface MockSessionFactory {
	factory: ControlSessionFactory;
	/** Every request the daemon made, in order. */
	requests: ControlSessionRequest[];
	/** Every session the factory built, in order. */
	sessions: AgentSession[];
	cleanup(): Promise<void>;
}

export async function createMockSessionFactory(mock: MockModel): Promise<MockSessionFactory> {
	// The CLI initializes the theme before any session exists; tools such as `ask` read it.
	await ensureTheme();
	const sourceId = `control-test-${crypto.randomUUID()}`;
	registerMockApi(sourceId);
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime(mock.model.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	// Subagents resolve their model through the registry; the mock model is the only one offered.
	const find = modelRegistry.find.bind(modelRegistry);
	spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
		provider === mock.model.provider && id === mock.model.id ? mock.model : find(provider, id),
	);
	spyOn(modelRegistry, "getAvailable").mockImplementation(() => [mock.model]);
	const requests: ControlSessionRequest[] = [];
	const sessions: AgentSession[] = [];
	const factory: ControlSessionFactory = async request => {
		requests.push(request);
		const result = await createAgentSession({
			...(request.agent ? sessionOptionsForAgent(request.agent) : {}),
			cwd: request.cwd,
			model: request.model ?? mock.model,
			disableModelFallback: request.model !== undefined,
			authStorage,
			modelRegistry,
			// Owned children run synchronously, as the control daemon configures them.
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"async.enabled": false,
				modelRoles: { default: `${mock.model.provider}/${mock.model.id}` },
			}),
			sessionManager: SessionManager.inMemory(),
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			// Mirrors the control daemon's session options: `ask` is offered, its decisions go to the daemon.
			interactivePrompts: true,
			subagentUi: request.subagentUi,
		});
		sessions.push(result.session);
		return { session: result.session, setToolUIContext: result.setToolUIContext };
	};
	return {
		factory,
		requests,
		sessions,
		async cleanup() {
			for (const session of sessions) await session.dispose();
			authStorage.close();
			unregisterCustomApis(sourceId);
		},
	};
}

/** A catalog source with fixed models and agents, so tests do not depend on user configuration. */
export function staticCatalog(models: readonly Model[], agents: readonly AgentDefinition[]): ControlCatalogSource {
	return { models: () => models, agents: async () => agents };
}

/** Start a daemon whose operations come from a real `ControlDaemon`. Close it with the returned `dispose`. */
export async function startDaemonWith(options: {
	catalog: ControlCatalogSource;
	createSession: ControlSessionFactory;
	daemonCwd: string;
	retention?: Partial<ControlRetentionTiming>;
}): Promise<{ server: TestDaemon; control: ControlDaemon; dispose(): Promise<void> }> {
	const control = new ControlDaemon(options);
	const server = await startTestDaemon({
		operations: control.operations(),
		onConnection: (principal, opened) => control.connectionChanged(principal, opened),
	});
	return {
		server,
		control,
		async dispose() {
			await server.close();
			await control.dispose();
		},
	};
}

/**
 * Start a daemon around `mock`, connect a bearer client, handshake and subscribe.
 * Use `createSession` to build a session for the workspace.
 */
export async function openSubscribedClient(options: {
	mock: MockModel;
	workspace: string;
	agents?: readonly AgentDefinition[];
	factory: ControlSessionFactory;
	retention?: Partial<ControlRetentionTiming>;
}): Promise<{ client: TestClient; server: TestDaemon; control: ControlDaemon; dispose(): Promise<void> }> {
	const started = await startDaemonWith({
		catalog: staticCatalog([options.mock.model], options.agents ?? []),
		createSession: options.factory,
		daemonCwd: options.workspace,
		retention: options.retention,
	});
	const client = await connectClient(started.server.url, started.server.bearerHeaders);
	await handshake(client);
	await subscribe(client);
	return {
		client,
		server: started.server,
		control: started.control,
		async dispose() {
			client.close();
			await started.dispose();
		},
	};
}

/** Create a session through the client and return its handle. */
export async function createSessionFor(
	client: TestClient,
	workspace: string,
	extra: Record<string, unknown> = {},
): Promise<string> {
	const reply = await client.request({
		version: 2,
		id: `create-${crypto.randomUUID()}`,
		type: "create_session",
		workspacePath: workspace,
		taskRef: "00000000-0000-4000-8000-0000000000aa",
		model: "mock/model-a",
		...extra,
	});
	if (reply.type !== "session_created") throw new Error(`create failed: ${JSON.stringify(reply)}`);
	return String(reply.sessionId);
}
