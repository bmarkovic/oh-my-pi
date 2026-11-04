/**
 * The control listener: one `Bun.serve` on loopback that upgrades authenticated
 * requests at `/control` into protocol connections. The front door (credentials,
 * bind rule, payload limit, heartbeat) lives here and is shared by every feature.
 */
import { logger } from "@oh-my-pi/pi-utils";
import {
	authenticateControlRequest,
	type ControlCredentials,
	type ControlPrincipal,
	validateControlCredentials,
} from "./control-auth";
import {
	ControlConnection,
	type ControlOperationHandler,
	type ControlOutboundLimits,
	DEFAULT_OUTBOUND_LIMITS,
	type ControlTiming,
} from "./control-connection";
import {
	assertPrivateCredentialFile,
	type ControlCredentialFiles,
	ControlCredentialWatch,
} from "./control-credential-file";
import { CONTROL_OPERATIONS } from "./control-operations";
import { CONTROL_MAX_MESSAGE_BYTES } from "./wire/envelope";

/** The only path the control protocol is served on. */
export const CONTROL_PATH = "/control";

/** Headroom above the high-water mark and one maximum frame, so Bun's backpressure limit is never reached. */
const CONTROL_BACKPRESSURE_SLACK_BYTES = 1_048_576;

/** How often credential files are stat-polled for rotation. */
export const DEFAULT_CREDENTIAL_POLL_MS = 2_000;

const DEFAULT_TIMING: ControlTiming = {
	helloTimeoutMs: 10_000,
	pingIntervalMs: 15_000,
	livenessTimeoutMs: 45_000,
};

export interface ControlServerOptions extends ControlCredentials {
	/**
	 * Credentials read from files and re-read as they change (see `ControlCredentialWatch`). When set, the
	 * fixed `bearerToken` and `controlKey` above are ignored for the files' principals.
	 */
	credentialFiles?: ControlCredentialFiles;
	/** Stat-poll interval for `credentialFiles`; defaults to `DEFAULT_CREDENTIAL_POLL_MS`. */
	credentialPollMs?: number;
	/** Host to bind. Defaults to `127.0.0.1`; other hosts need `tls`, and wildcard addresses are refused (see `bindPolicy`). */
	hostname?: string;
	/** Terminate TLS with these files, serving `wss://`. Absent means plain `ws://`. */
	tls?: ControlTlsFiles;
	/** Port to bind; `0` picks a free port. */
	port?: number;
	/** Deadline overrides; defaults follow the shared wire profile. */
	timing?: Partial<ControlTiming>;
	/** Command table; defaults to the operations available on this build. */
	operations?: ReadonlyMap<string, ControlOperationHandler>;
	/** Outbound flow-control bounds; defaults follow `DEFAULT_OUTBOUND_LIMITS`. */
	outbound?: Partial<ControlOutboundLimits>;
	/** Told when an authenticated connection opens or closes, for the owner's orphan clock. */
	onConnection?: (principal: ControlPrincipal, opened: boolean) => void;
}

export interface ControlServerHandle {
	/** Full `ws://` or `wss://` URL including the `/control` path. */
	readonly url: string;
	/** Stop accepting new connections. Open connections stay open, so the daemon can still answer them. */
	stopAccepting(): void;
	/**
	 * Flush every connection's queued frames (bounded), close each with 1001, and stop the listener. Resolves
	 * once the connections have closed, or after a short grace period.
	 */
	close(): Promise<void>;
}

/** How long `close` waits for queued frames to reach the transport. */
const FLUSH_GRACE_MS = 500;
/** How long `close` waits for connections to finish their close handshake. */
const CLOSE_GRACE_MS = 1_000;

interface ControlSocketData {
	principal: ControlPrincipal;
	connection?: ControlConnection;
}

/** True for hosts that only accept loopback peers (`127.0.0.0/8`, `::1`, `localhost`). */
export function isLoopbackHost(host: string): boolean {
	if (host === "localhost" || host === "::1") return true;
	const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	return match !== null && match.slice(1).every(octet => Number(octet) <= 255);
}

/** Canonical forms of the addresses that listen on every interface. */
const WILDCARD_ADDRESSES: ReadonlySet<string> = new Set(["0.0.0.0", "[::]", "[::ffff:0:0]"]);

/**
 * True when `hostname` listens on every interface in any spelling the listener's resolver accepts: `0`,
 * `0x0` and `0.0` all bind 0.0.0.0, and `::0` or `0:0:0:0:0:0:0:0` bind `::`. The URL parser reduces
 * those spellings to one canonical form.
 */
function isWildcardHost(hostname: string): boolean {
	if (hostname === "") return true;
	try {
		const bracketed = hostname.includes(":") ? `[${hostname}]` : hostname;
		return WILDCARD_ADDRESSES.has(new URL(`http://${bracketed}`).hostname);
	} catch {
		return false;
	}
}

/**
 * Why the listener may not bind `hostname`, or `undefined` when it may. Loopback is allowed with or
 * without TLS. Other hosts need TLS. Wildcard addresses are refused even with TLS: the printed URL must
 * name a host that a client can dial and that the certificate can cover, and a wildcard is neither.
 */
export function bindPolicy(hostname: string, tls: boolean): string | undefined {
	if (isLoopbackHost(hostname)) return undefined;
	if (!tls) return `--bind ${hostname} is a non-loopback address; pass --tls-cert and --tls-key`;
	if (isWildcardHost(hostname)) {
		return `--bind ${hostname} is a wildcard address; bind a specific interface address or host name so the printed URL can be dialed and its certificate checked`;
	}
	return undefined;
}

/** PEM files that terminate TLS on the listener. Loaded before listening; the key must be owner-only. */
export interface ControlTlsFiles {
	certFile: string;
	keyFile: string;
}

export async function startControlServer(options: ControlServerOptions): Promise<ControlServerHandle> {
	const hostname = options.hostname ?? "127.0.0.1";
	const bindProblem = bindPolicy(hostname, options.tls !== undefined);
	if (bindProblem !== undefined) throw new Error(`control server refuses to start: ${bindProblem}`);
	// The private key is a credential: the listener refuses one other accounts can read, whoever started it.
	if (options.tls !== undefined) await assertPrivateCredentialFile(options.tls.keyFile);
	const files = options.credentialFiles;
	const watch =
		files !== undefined && (files.bearerTokenFile !== undefined || files.controlKeyFile !== undefined)
			? new ControlCredentialWatch(files, options.credentialPollMs ?? DEFAULT_CREDENTIAL_POLL_MS)
			: undefined;
	// File credentials are read before anything is served: an unusable file fails startup, not one upgrade.
	await watch?.load();
	// A principal backed by a file follows the file (absent while it is refused); the others keep their fixed value.
	const credentials = (): ControlCredentials => {
		const live = watch?.current() ?? {};
		return {
			bearerToken: files?.bearerTokenFile !== undefined ? live.bearerToken : options.bearerToken,
			controlKey: files?.controlKeyFile !== undefined ? live.controlKey : options.controlKey,
		};
	};
	validateControlCredentials(credentials());
	const timing: ControlTiming = { ...DEFAULT_TIMING, ...options.timing };
	const outbound: ControlOutboundLimits = { ...DEFAULT_OUTBOUND_LIMITS, ...options.outbound };
	const operations = options.operations ?? CONTROL_OPERATIONS;
	const onConnection = options.onConnection;
	const connections = new Set<ControlConnection>();

	const tls = options.tls ? { cert: Bun.file(options.tls.certFile), key: Bun.file(options.tls.keyFile) } : undefined;
	const server = Bun.serve<ControlSocketData>({
		hostname,
		port: options.port ?? 0,
		tls,
		fetch(request, bunServer) {
			if (new URL(request.url).pathname !== CONTROL_PATH) return new Response("Not found", { status: 404 });
			const principal = authenticateControlRequest(request, credentials());
			if (principal === undefined) return new Response("Unauthorized", { status: 401 });
			if (bunServer.upgrade(request, { data: { principal } })) return undefined;
			return new Response("Upgrade required", { status: 426 });
		},
		websocket: {
			maxPayloadLength: CONTROL_MAX_MESSAGE_BYTES,
			// The connection sends only while the transport holds at most the high-water mark, so this limit is
			// never reached; it is sized above that mark plus one maximum frame so the transport never drops a frame.
			backpressureLimit: outbound.highWaterBytes + CONTROL_MAX_MESSAGE_BYTES + CONTROL_BACKPRESSURE_SLACK_BYTES,
			closeOnBackpressureLimit: false,
			// Heartbeat is owned by ControlConnection so the liveness window is ours to configure.
			sendPings: false,
			open(ws) {
				const connection = new ControlConnection({
					socket: {
						send: text => ws.send(text),
						bufferedAmount: () => ws.getBufferedAmount(),
						close: (code, reason) => ws.close(code, reason),
						ping: () => ws.ping(),
						terminate: () => ws.terminate(),
					},
					principal: ws.data.principal,
					timing,
					operations,
					outbound,
				});
				ws.data.connection = connection;
				connections.add(connection);
				connection.start();
				onConnection?.(ws.data.principal, true);
			},
			drain(ws) {
				ws.data.connection?.flush();
			},
			message(ws, message) {
				if (typeof message !== "string") {
					ws.close(1003, "binary messages are not supported");
					return;
				}
				ws.data.connection?.receive(message);
			},
			pong(ws) {
				ws.data.connection?.noteInbound();
			},
			close(ws) {
				const connection = ws.data.connection;
				if (!connection) return;
				connection.dispose();
				connections.delete(connection);
				onConnection?.(ws.data.principal, false);
			},
		},
	});

	watch?.start();
	/** Push queued frames toward the transport: a drain event may not come when a socket has already emptied. */
	const flushAll = () => {
		for (const connection of connections) connection.flush();
	};

	const host = hostname.includes(":") ? `[${hostname}]` : hostname;
	const url = `${tls ? "wss" : "ws"}://${host}:${server.port}${CONTROL_PATH}`;
	logger.debug("control listener started", { port: server.port, hostname, tls: tls !== undefined });

	return {
		url,
		stopAccepting() {
			server.stop(false);
		},
		async close() {
			watch?.stop();
			await waitFor(() => [...connections].every(connection => connection.drained), FLUSH_GRACE_MS, flushAll);
			for (const connection of connections) connection.shutdown();
			await waitFor(() => connections.size === 0, CLOSE_GRACE_MS);
			await server.stop(true);
		},
	};
}

/** Poll `done` until it holds or `timeoutMs` passes, calling `tick` between checks. Never throws. */
async function waitFor(done: () => boolean, timeoutMs: number, tick?: () => void): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!done() && performance.now() < deadline) {
		tick?.();
		await Bun.sleep(5);
	}
}
