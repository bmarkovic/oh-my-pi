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
import { CONTROL_OPERATIONS } from "./control-operations";
import { CONTROL_MAX_MESSAGE_BYTES } from "./wire/envelope";

/** The only path the control protocol is served on. */
export const CONTROL_PATH = "/control";

const DEFAULT_TIMING: ControlTiming = {
	helloTimeoutMs: 10_000,
	pingIntervalMs: 15_000,
	livenessTimeoutMs: 45_000,
};

export interface ControlServerOptions extends ControlCredentials {
	/** Loopback host to bind. Defaults to `127.0.0.1`; any other host is refused. */
	hostname?: string;
	/** Port to bind; `0` picks a free port. */
	port?: number;
	/** Deadline overrides; defaults follow the shared wire profile. */
	timing?: Partial<ControlTiming>;
	/** Command table; defaults to the operations available on this build. */
	operations?: ReadonlyMap<string, ControlOperationHandler>;
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

export async function startControlServer(options: ControlServerOptions): Promise<ControlServerHandle> {
	validateControlCredentials(options);
	const hostname = options.hostname ?? "127.0.0.1";
	if (!isLoopbackHost(hostname)) {
		throw new Error(
			`control server refuses non-loopback bind ${hostname}: remote control requires TLS, which is not available yet`,
		);
	}
	const timing: ControlTiming = { ...DEFAULT_TIMING, ...options.timing };
	const operations = options.operations ?? CONTROL_OPERATIONS;
	const connections = new Set<ControlConnection>();

	const server = Bun.serve<ControlSocketData>({
		hostname,
		port: options.port ?? 0,
		fetch(request, bunServer) {
			if (new URL(request.url).pathname !== CONTROL_PATH) return new Response("Not found", { status: 404 });
			const principal = authenticateControlRequest(request, options);
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
			},
		},
	});

	const host = hostname.includes(":") ? `[${hostname}]` : hostname;
	const url = `ws://${host}:${server.port}${CONTROL_PATH}`;
	logger.debug("control listener started", { port: server.port, hostname });

	return {
		url,
		async close() {
			for (const connection of connections) connection.shutdown();
			connections.clear();
			await server.stop(true);
		},
	};
}
