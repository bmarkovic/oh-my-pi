/**
 * Protocol state for one authenticated WebSocket: envelope validation, the
 * hello/welcome handshake, subscription, duplicate-id protection, the heartbeat,
 * and routing of accepted commands to their operation handlers.
 */
import { OmpErrors } from "@oh-my-pi/omptype";
import { logger } from "@oh-my-pi/pi-utils";
import type { ControlPrincipal } from "./control-auth";
import { CONTROL_PROTOCOL_VERSION, helloCommand, isPlainObject, welcomeFrame } from "./wire/envelope";
import { type ControlErrorCode, controlError } from "./wire/errors";

/** The transport surface a connection needs. The server adapts a Bun WebSocket to it. */
export interface ControlSocket {
	send(text: string): void;
	close(code: number, reason: string): void;
	ping(): void;
	terminate(): void;
}

/** Protocol deadlines in milliseconds (contract section 2.2 and the shared wire profile). */
export interface ControlTiming {
	helloTimeoutMs: number;
	pingIntervalMs: number;
	livenessTimeoutMs: number;
}

/** Handles one validated-envelope command of one type. The raw payload is validated by the handler. */
export type ControlOperationHandler = (connection: ControlConnection, id: string, raw: Record<string, unknown>) => void;

export interface ControlConnectionOptions {
	socket: ControlSocket;
	principal: ControlPrincipal;
	timing: ControlTiming;
	operations: ReadonlyMap<string, ControlOperationHandler>;
}

/** Close codes used by the daemon (RFC 6455 section 7.4.1). */
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_GOING_AWAY = 1001;

export class ControlConnection {
	readonly principal: ControlPrincipal;
	readonly #socket: ControlSocket;
	readonly #timing: ControlTiming;
	readonly #operations: ReadonlyMap<string, ControlOperationHandler>;
	readonly #seenIds = new Set<string>();
	/** Root sessions whose live events this connection receives (created here, or reclaimed by `reconnect`). */
	readonly #attached = new Set<string>();
	#negotiated = false;
	#subscribed = false;
	#closed = false;
	#lastInboundAt = performance.now();
	#helloTimer: Timer | undefined;
	#heartbeatTimer: Timer | undefined;

	constructor(options: ControlConnectionOptions) {
		this.principal = options.principal;
		this.#socket = options.socket;
		this.#timing = options.timing;
		this.#operations = options.operations;
	}

	get negotiated(): boolean {
		return this.#negotiated;
	}

	get subscribed(): boolean {
		return this.#subscribed;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Start the hello deadline and the heartbeat. Called once the upgrade succeeded. */
	start(): void {
		this.#helloTimer = setTimeout(() => {
			if (!this.#negotiated) this.#fail(CLOSE_POLICY_VIOLATION, "hello timeout");
		}, this.#timing.helloTimeoutMs);
		this.#heartbeatTimer = setInterval(() => this.#heartbeat(), this.#timing.pingIntervalMs);
	}

	/** Any inbound traffic, including a pong, proves the peer is alive. */
	noteInbound(): void {
		this.#lastInboundAt = performance.now();
	}

	/** Mark the connection subscribed. Idempotent. */
	subscribe(): void {
		this.#subscribed = true;
	}

	/** Start delivering a root session's events to this connection. */
	attach(sessionId: string): void {
		this.#attached.add(sessionId);
	}

	/** Stop delivering a root session's events to this connection. */
	detach(sessionId: string): void {
		this.#attached.delete(sessionId);
	}

	isAttached(sessionId: string): boolean {
		return this.#attached.has(sessionId);
	}

	/** Send one server frame. Dropped once the connection is closed. */
	reply(frame: object): void {
		if (this.#closed) return;
		this.#socket.send(JSON.stringify(frame));
	}

	/** Reject one command with a typed error. Uncorrelated when `inReplyTo` is absent. */
	reject(code: ControlErrorCode, message: string, inReplyTo?: string): void {
		this.reply(controlError(code, message, inReplyTo));
	}

	/** Release timers after the transport closed. Idempotent. */
	dispose(): void {
		this.#closed = true;
		this.#clearTimers();
	}

	/** Process one inbound text message. */
	receive(text: string): void {
		if (this.#closed) return;
		this.noteInbound();

		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			this.reject("invalid_message", "message is not valid JSON");
			return;
		}
		if (!isPlainObject(raw)) {
			this.reject("invalid_message", "message must be a JSON object");
			return;
		}
		const id = typeof raw.id === "string" && /\S/.test(raw.id) ? raw.id : undefined;
		if (id === undefined) {
			this.reject("invalid_message", "command id must be a non-empty string");
			return;
		}
		if (!Number.isSafeInteger(raw.version)) {
			this.reject("invalid_message", "version must be an integer", id);
			return;
		}
		if (raw.version !== CONTROL_PROTOCOL_VERSION) {
			this.reject("version_mismatch", `envelope version ${String(raw.version)} is not supported`, id);
			return;
		}
		if (typeof raw.type !== "string") {
			this.reject("invalid_message", "command type must be a string", id);
			return;
		}
		if (!this.#negotiated && raw.type !== "hello") {
			const known = this.#operations.has(raw.type);
			if (known) this.reject("handshake_required", "hello must be the first command", id);
			else this.reject("invalid_message", "unknown command type", id);
			return;
		}
		if (this.#seenIds.has(id)) {
			this.reject("invalid_message", "command id was already used on this connection", id);
			return;
		}
		this.#seenIds.add(id);

		if (!this.#negotiated) {
			this.#hello(id, raw);
			return;
		}
		if (raw.type === "hello") {
			this.reject("unsupported_operation", "hello is valid once per connection", id);
			return;
		}
		const handler = this.#operations.get(raw.type);
		if (!handler) {
			this.reject("invalid_message", "unknown command type", id);
			return;
		}
		handler(this, id, raw);
	}

	#hello(id: string, raw: Record<string, unknown>): void {
		const parsed = helloCommand(raw);
		if (parsed instanceof OmpErrors) {
			this.reject("invalid_message", "hello requires supportedVersions", id);
			return;
		}
		const proposals: unknown[] = Array.isArray(raw.supportedVersions) ? raw.supportedVersions : [];
		const wellFormed =
			proposals.length > 0 &&
			proposals.every(entry => Number.isSafeInteger(entry) && (entry as number) > 0) &&
			new Set(proposals).size === proposals.length;
		if (!wellFormed) {
			this.reject("invalid_message", "supportedVersions must be distinct positive integers", id);
			return;
		}
		if (!proposals.includes(CONTROL_PROTOCOL_VERSION)) {
			this.reject("version_mismatch", "No mutually supported version", id);
			this.#fail(CLOSE_PROTOCOL_ERROR, "version mismatch");
			return;
		}
		this.#negotiated = true;
		clearTimeout(this.#helloTimer);
		this.#helloTimer = undefined;
		this.reply(welcomeFrame(id));
	}

	#heartbeat(): void {
		if (this.#closed) return;
		if (performance.now() - this.#lastInboundAt > this.#timing.livenessTimeoutMs) {
			logger.debug("control connection lost: no inbound traffic within liveness window", {
				principal: this.principal,
			});
			this.#closed = true;
			this.#clearTimers();
			this.#socket.terminate();
			return;
		}
		this.#socket.ping();
	}

	#fail(code: number, reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearTimers();
		this.#socket.close(code, reason);
	}

	/** Close during server shutdown. */
	shutdown(): void {
		this.#fail(CLOSE_GOING_AWAY, "server shutting down");
	}

	#clearTimers(): void {
		clearTimeout(this.#helloTimer);
		clearInterval(this.#heartbeatTimer);
		this.#helloTimer = undefined;
		this.#heartbeatTimer = undefined;
	}
}
