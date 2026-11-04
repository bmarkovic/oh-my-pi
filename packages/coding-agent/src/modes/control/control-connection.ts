/**
 * Protocol state for one authenticated WebSocket: envelope validation, the
 * hello/welcome handshake, subscription, duplicate-id protection, the heartbeat,
 * and routing of accepted commands to their operation handlers.
 */
import { OmpErrors } from "@oh-my-pi/omptype";
import { logger } from "@oh-my-pi/pi-utils";
import type { ControlPrincipal } from "./control-auth";
import {
	CONTROL_MAX_MESSAGE_BYTES,
	CONTROL_PROTOCOL_VERSION,
	helloCommand,
	isPlainObject,
	welcomeFrame,
} from "./wire/envelope";
import { type ControlErrorCode, controlError } from "./wire/errors";

/**
 * The transport surface a connection needs. The server adapts a Bun WebSocket to it. `send` returns the
 * transport's status: bytes written, `-1` when the transport queued the frame, `0` when the socket is gone.
 */
export interface ControlSocket {
	send(text: string): number;
	/** Bytes the transport has accepted but not yet written to the peer. */
	bufferedAmount(): number;
	close(code: number, reason: string): void;
	ping(): void;
	terminate(): void;
}

/** Outbound flow-control bounds. Frames are queued past the high-water mark and bounded by the queue limit. */
export interface ControlOutboundLimits {
	/** Send directly only while the transport holds at most this many bytes. */
	highWaterBytes: number;
	/** UTF-8 bytes of frames the connection may queue. Overflow closes the connection with 1013. */
	queueLimitBytes: number;
}

export const DEFAULT_OUTBOUND_LIMITS: ControlOutboundLimits = {
	highWaterBytes: 1_048_576,
	queueLimitBytes: 67_108_864,
};

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
	outbound?: Partial<ControlOutboundLimits>;
}

/** Close codes used by the daemon (RFC 6455 section 7.4.1). */
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_GOING_AWAY = 1001;
/** A frame could not be made to fit the message limit: a defect the client must not receive. */
const CLOSE_INTERNAL_ERROR = 1011;
/** IANA "Try Again Later": transient transport loss, the peer should reconnect. */
const CLOSE_TRY_AGAIN_LATER = 1013;
/** How long a closing connection may take to complete its close handshake before the socket is torn down. */
const CLOSE_GRACE_MS = 2_000;

export class ControlConnection {
	readonly principal: ControlPrincipal;
	readonly #socket: ControlSocket;
	readonly #timing: ControlTiming;
	readonly #operations: ReadonlyMap<string, ControlOperationHandler>;
	readonly #outboundLimits: ControlOutboundLimits;
	/** Serialized frames waiting for the transport, in send order. Replies and events share this queue. */
	readonly #outbound: string[] = [];
	#outboundBytes = 0;
	readonly #seenIds = new Set<string>();
	/** Root sessions whose live events this connection receives (created here, or reclaimed by `reconnect`). */
	readonly #attached = new Set<string>();
	#negotiated = false;
	#subscribed = false;
	#closed = false;
	#lastInboundAt = performance.now();
	#helloTimer: Timer | undefined;
	#heartbeatTimer: Timer | undefined;
	#closeTimer: Timer | undefined;

	constructor(options: ControlConnectionOptions) {
		this.principal = options.principal;
		this.#socket = options.socket;
		this.#timing = options.timing;
		this.#operations = options.operations;
		this.#outboundLimits = { ...DEFAULT_OUTBOUND_LIMITS, ...options.outbound };
	}

	/** True once every queued frame has been written to the transport. */
	get drained(): boolean {
		return this.#outbound.length === 0 && this.#socket.bufferedAmount() === 0;
	}

	/** True while frames wait for the transport. Pings are not queued, so the heartbeat skips them meanwhile. */
	get congested(): boolean {
		return this.#outbound.length > 0 || this.#socket.bufferedAmount() > this.#outboundLimits.highWaterBytes;
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

	/** Send one server frame, in order behind any frame still queued. Dropped once the connection is closed. */
	reply(frame: object): void {
		if (this.#closed) return;
		const text = JSON.stringify(frame);
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes > CONTROL_MAX_MESSAGE_BYTES) {
			// Elision keeps every event within the limit, so a frame still over it is a defect. Never send it.
			const type = isPlainObject(frame) && typeof frame.type === "string" ? frame.type : undefined;
			logger.error("control frame exceeds the message limit; closing", { type, bytes });
			this.#fail(CLOSE_INTERNAL_ERROR, "frame exceeds the message limit");
			return;
		}
		this.#enqueue(text, bytes);
	}

	/**
	 * Send queued frames while the transport has room. The server calls this when the transport reports
	 * that its buffer drained.
	 */
	flush(): void {
		while (
			!this.#closed &&
			this.#outbound.length > 0 &&
			this.#socket.bufferedAmount() <= this.#outboundLimits.highWaterBytes
		) {
			const text = this.#outbound.shift();
			if (text === undefined) return;
			this.#outboundBytes -= Buffer.byteLength(text, "utf8");
			this.#transmit(text);
		}
	}

	#enqueue(text: string, bytes: number): void {
		if (this.#outbound.length === 0 && this.#socket.bufferedAmount() <= this.#outboundLimits.highWaterBytes) {
			this.#transmit(text);
			return;
		}
		if (this.#outboundBytes + bytes > this.#outboundLimits.queueLimitBytes) {
			// The peer cannot keep up. Nothing after the delivered prefix is sent; the client reconnects and reconciles.
			logger.warn("control connection outbound backlog exceeded", { principal: this.principal });
			this.#outbound.length = 0;
			this.#outboundBytes = 0;
			this.#fail(CLOSE_TRY_AGAIN_LATER, "outbound backlog exceeded");
			return;
		}
		this.#outbound.push(text);
		this.#outboundBytes += bytes;
	}

	#transmit(text: string): void {
		if (this.#socket.send(text) !== 0) return;
		// Status 0 means the socket is gone: nothing more can be delivered on it.
		this.#closed = true;
		this.#outbound.length = 0;
		this.#outboundBytes = 0;
		this.#clearTimers();
		this.#socket.terminate();
	}

	/** Reject one command with a typed error. Uncorrelated when `inReplyTo` is absent. */
	reject(code: ControlErrorCode, message: string, inReplyTo?: string): void {
		this.reply(controlError(code, message, inReplyTo));
	}

	/** Release timers after the transport closed. Idempotent. */
	dispose(): void {
		this.#closed = true;
		this.#clearTimers();
		clearTimeout(this.#closeTimer);
		this.#closeTimer = undefined;
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
		if (this.congested) return;
		this.#socket.ping();
	}

	#fail(code: number, reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearTimers();
		this.#socket.close(code, reason);
		// If the close handshake never completes, the transport must not stay open past the grace period.
		this.#closeTimer = setTimeout(() => this.#socket.terminate(), CLOSE_GRACE_MS);
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
