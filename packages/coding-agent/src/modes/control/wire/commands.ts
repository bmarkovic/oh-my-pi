/**
 * Session-level command schemas and replies for the catalog and creation commands.
 */
import { type } from "@oh-my-pi/omptype";
import { CONTROL_PROTOCOL_VERSION } from "./envelope";

/** RFC 4122 textual UUID, any version. */
export const UUID_PATTERN = "/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/";

export const queryCatalogCommand = type({ type: "'query_catalog'" });

export const createSessionCommand = type({
	type: "'create_session'",
	workspacePath: "/\\S/",
	taskRef: UUID_PATTERN,
	"agent?": "/\\S/",
	"model?": "/\\S/",
	"timeoutMs?": "number.integer>0",
	"tools?": "unknown[]",
});

export const interruptSessionCommand = type({
	type: "'interrupt_session'",
	sessionId: "/\\S/",
});

export const promptSessionCommand = type({
	type: "'prompt_session'",
	sessionId: "/\\S/",
	prompt: "/\\S/",
	"operatorUserId?": "/\\S/",
	"tools?": "unknown[]",
});

export interface PromptSessionCommand {
	type: "prompt_session";
	sessionId: string;
	prompt: string;
	operatorUserId?: string;
	tools?: unknown[];
}

export interface CreateSessionCommand {
	type: "create_session";
	workspacePath: string;
	taskRef: string;
	agent?: string;
	model?: string;
	timeoutMs?: number;
	tools?: unknown[];
}

/** A selectable agent on the wire: name and description only, never its prompt or path. */
export interface ControlCatalogAgent {
	name: string;
	description: string;
	roles: string[];
	defaultModel?: string;
}

/** A selectable model on the wire. `id` is `provider/modelId`. */
export interface ControlCatalogModel {
	id: string;
	provider: string;
}

export interface CatalogFrame {
	version: typeof CONTROL_PROTOCOL_VERSION;
	inReplyTo: string;
	type: "catalog";
	agents: ControlCatalogAgent[];
	models: ControlCatalogModel[];
}

export function catalogFrame(
	inReplyTo: string,
	catalog: { agents: ControlCatalogAgent[]; models: ControlCatalogModel[] },
): CatalogFrame {
	return {
		version: CONTROL_PROTOCOL_VERSION,
		inReplyTo,
		type: "catalog",
		agents: catalog.agents,
		models: catalog.models,
	};
}

export interface SessionCreatedFrame {
	version: typeof CONTROL_PROTOCOL_VERSION;
	inReplyTo: string;
	type: "session_created";
	sessionId: string;
}

export function sessionCreatedFrame(inReplyTo: string, sessionId: string): SessionCreatedFrame {
	return { version: CONTROL_PROTOCOL_VERSION, inReplyTo, type: "session_created", sessionId };
}
