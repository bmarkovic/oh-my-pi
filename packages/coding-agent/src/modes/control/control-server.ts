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
import { ControlConnection, type ControlOperationHandler, type ControlTiming } from "./control-connection";
import { type ControlCredentialFiles, ControlCredentialWatch } from "./control-credential-file";
import { CONTROL_OPERATIONS } from "./control-operations";
import { CONTROL_MAX_MESSAGE_BYTES } from "./wire/envelope";

/** The only path the control protocol is served on. */
export const CONTROL_PATH = "/control";

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
	/** Told when an authenticated connection opens or closes, for the owner's orphan clock. */
	onConnection?: (principal: ControlPrincipal, opened: boolean) => void;
}

export interface ControlServerHandle {
	/** Full `ws://` URL including the `/control` path. */
	readonly url: string;
	/** Stop listening and close every connection. */
	close(): Promise<void>;
}

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

const WILDCARD_HOSTS: ReadonlySet<string> = new Set(["", "0.0.0.0", "::"]);

/**
 * Why the listener may not bind `hostname`, or `undefined` when it may. Loopback is allowed with or
 * without TLS. Other hosts need TLS. Wildcard addresses are refused even with TLS: the printed URL must
 * name a host that a client can dial and that the certificate can cover, and a wildcard is neither.
 */
export function bindPolicy(hostname: string, tls: boolean): string | undefined {
	if (isLoopbackHost(hostname)) return undefined;
	if (!tls) return `--bind ${hostname} is a non-loopback address; pass --tls-cert and --tls-key`;
	if (WILDCARD_HOSTS.has(hostname)) {
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
			// Heartbeat is owned by ControlConnection so the liveness window is ours to configure.
			sendPings: false,
			open(ws) {
				const connection = new ControlConnection({
					socket: {
						send: text => ws.send(text),
						close: (code, reason) => ws.close(code, reason),
						ping: () => ws.ping(),
						terminate: () => ws.terminate(),
					},
					principal: ws.data.principal,
					timing,
					operations,
				});
				ws.data.connection = connection;
				connections.add(connection);
				connection.start();
				onConnection?.(ws.data.principal, true);
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
	const host = hostname.includes(":") ? `[${hostname}]` : hostname;
	const url = `${tls ? "wss" : "ws"}://${host}:${server.port}${CONTROL_PATH}`;
	logger.debug("control listener started", { port: server.port, hostname, tls: tls !== undefined });

	return {
		url,
		async close() {
			watch?.stop();
			for (const connection of connections) connection.shutdown();
			connections.clear();
			await server.stop(true);
		},
	};
}
