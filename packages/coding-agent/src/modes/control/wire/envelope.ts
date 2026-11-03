/**
 * OMP control protocol v2 envelopes: the version constant, the handshake and
 * connection-level command schemas, and the reply builders that answer them.
 */
import { type } from "@oh-my-pi/omptype";

/** The only protocol version this daemon speaks (contract section 2.3). */
export const CONTROL_PROTOCOL_VERSION = 2 as const;

/** Largest reassembled message in either direction, in bytes (contract section 2.1). */
export const CONTROL_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Test whether a value is a non-null object that is not an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `hello`: the proposal list is checked element by element by the connection (non-empty, distinct). */
export const helloCommand = type({
	type: "'hello'",
	supportedVersions: "unknown[]",
});

export const subscribeEventsCommand = type({ type: "'subscribe_events'" });

export const queryCapabilitiesCommand = type({ type: "'query_capabilities'" });

/** Reply to a `hello` that selected protocol version 2. */
export interface WelcomeFrame {
	version: typeof CONTROL_PROTOCOL_VERSION;
	inReplyTo: string;
	type: "welcome";
	selectedVersion: typeof CONTROL_PROTOCOL_VERSION;
}

export function welcomeFrame(inReplyTo: string): WelcomeFrame {
	return {
		version: CONTROL_PROTOCOL_VERSION,
		inReplyTo,
		type: "welcome",
		selectedVersion: CONTROL_PROTOCOL_VERSION,
	};
}

/** Acceptance of a command. It means accepted, not completed. */
export interface AckFrame {
	version: typeof CONTROL_PROTOCOL_VERSION;
	inReplyTo: string;
	type: "ack";
}

export function ackFrame(inReplyTo: string): AckFrame {
	return { version: CONTROL_PROTOCOL_VERSION, inReplyTo, type: "ack" };
}

/** Feature list answering `query_capabilities`. */
export interface CapabilitiesFrame {
	version: typeof CONTROL_PROTOCOL_VERSION;
	inReplyTo: string;
	type: "capabilities";
	features: string[];
}

export function capabilitiesFrame(inReplyTo: string, features: readonly string[]): CapabilitiesFrame {
	return { version: CONTROL_PROTOCOL_VERSION, inReplyTo, type: "capabilities", features: [...features] };
}
