/**
 * Command error taxonomy (contract section 8.1). Each code rejects one command;
 * none of them is an asynchronous run outcome.
 */
import { CONTROL_PROTOCOL_VERSION } from "./envelope";

export const CONTROL_ERROR_CODES = [
	"version_mismatch",
	"handshake_required",
	"invalid_message",
	"unknown_session",
	"unsupported_operation",
	"invalid_workspace",
	"unknown_agent",
	"unknown_model",
	"invalid_decision_state",
] as const;

export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

/** A command rejection. `inReplyTo` is absent only when the command id could not be read. */
export interface ControlErrorFrame {
	version: typeof CONTROL_PROTOCOL_VERSION;
	type: "error";
	inReplyTo?: string;
	code: ControlErrorCode;
	message: string;
}

/** Build a command rejection frame. `message` is diagnostic text only; consumers act on `code`. */
export function controlError(code: ControlErrorCode, message: string, inReplyTo?: string): ControlErrorFrame {
	const frame: ControlErrorFrame = { version: CONTROL_PROTOCOL_VERSION, type: "error", code, message };
	if (inReplyTo !== undefined) frame.inReplyTo = inReplyTo;
	return frame;
}
