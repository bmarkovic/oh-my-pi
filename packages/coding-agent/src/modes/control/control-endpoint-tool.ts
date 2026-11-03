/**
 * Tool bindings: operator-supplied HTTP endpoints exposed to the model as tools.
 * A binding is validated in full before anything is installed. Each call POSTs the
 * model's JSON input with the binding's bearer token, and the token is removed from
 * anything returned to the model or reported in an error.
 */
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { fromJsonSchema } from "@oh-my-pi/omptype";
import { decodeBody, readBodyCapped } from "../../web/response-body";
import { CONTROL_MAX_MESSAGE_BYTES, isPlainObject } from "./wire/envelope";

/** One validated binding from `create_session.tools` or `prompt_session.tools`. */
export interface ControlToolBinding {
	name: string;
	description: string;
	endpointUrl: string;
	authToken: string;
	schema: Record<string, unknown>;
}

/** Placeholder that replaces the bearer token wherever it would otherwise be echoed. */
const REDACTED = "[redacted]";

/**
 * Validate a whole binding set. Throws with a message naming the field and index
 * only, never a value, because values include the bearer token.
 */
export function parseToolBindings(raw: unknown): ControlToolBinding[] {
	if (!Array.isArray(raw)) throw new Error("tools must be an array");
	const names = new Set<string>();
	return raw.map((entry, index): ControlToolBinding => {
		const where = `tools[${index}]`;
		if (!isPlainObject(entry)) throw new Error(`${where} must be an object`);
		const { name, description, endpointUrl, authToken, schema } = entry;
		if (typeof name !== "string" || !/\S/.test(name)) throw new Error(`${where}.name must be a non-empty string`);
		if (names.has(name)) throw new Error(`${where}.name duplicates another binding`);
		names.add(name);
		if (typeof description !== "string") throw new Error(`${where}.description must be a string`);
		if (typeof endpointUrl !== "string" || !isHttpUrl(endpointUrl)) {
			throw new Error(`${where}.endpointUrl must be an absolute http(s) URL`);
		}
		if (typeof authToken !== "string" || !/\S/.test(authToken)) {
			throw new Error(`${where}.authToken must be a non-empty string`);
		}
		if (!isPlainObject(schema)) throw new Error(`${where}.schema must be a JSON Schema object`);
		try {
			fromJsonSchema(schema);
		} catch {
			throw new Error(`${where}.schema cannot be used as a tool input schema`);
		}
		return { name, description, endpointUrl, authToken, schema };
	});
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/** Replace every occurrence of the bearer token with a placeholder. */
export function redactToken(text: string, token: string): string {
	return text.split(token).join(REDACTED);
}

/** One binding as an agent tool: each execution is one authenticated POST to its endpoint. */
export function createEndpointTool(binding: ControlToolBinding): AgentTool {
	const parameters = fromJsonSchema(binding.schema);
	return {
		name: binding.name,
		label: binding.name,
		description: binding.description,
		parameters,
		strict: true,
		concurrency: "shared",
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
			let response: Response;
			try {
				response = await fetch(binding.endpointUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${binding.authToken}`,
					},
					body: JSON.stringify(params ?? {}),
					signal,
				});
			} catch {
				throw new Error(`tool ${binding.name} could not reach its endpoint`);
			}
			const body = await readBodyCapped(response, CONTROL_MAX_MESSAGE_BYTES);
			if (body?.truncated) throw new Error(`tool ${binding.name} response exceeds the size limit`);
			if (!response.ok) throw new Error(`tool ${binding.name} endpoint returned HTTP ${response.status}`);
			const text = redactToken(
				body ? decodeBody(body.bytes, response.headers.get("content-type") ?? "") : "",
				binding.authToken,
			);
			return { content: [{ type: "text", text }] };
		},
	} as AgentTool;
}
