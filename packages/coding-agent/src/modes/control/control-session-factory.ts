/**
 * Session construction for control handles. The daemon asks for a session by
 * workspace, agent definition and model; this module maps those onto the
 * headless session factory's existing options, the same way subagent spawning
 * maps an agent definition (`task/executor.ts`), with no new session path.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import type { CreateAgentSessionOptions } from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import type { AgentDefinition, SubagentUiRouter } from "../../task/types";

/** What a control `create_session` asks for after catalog resolution. */
export interface ControlSessionRequest {
	cwd: string;
	agent?: AgentDefinition;
	model?: Model;
	/** Gives subagents this session spawns their own UI and tools. */
	subagentUi?: SubagentUiRouter;
}

export interface ControlSessionHandle {
	session: AgentSession;
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
}

/** Builds one session for a validated request. Failure must leave nothing running. */
export type ControlSessionFactory = (request: ControlSessionRequest) => Promise<ControlSessionHandle>;

/** Session options an agent definition contributes; the same fields subagent spawning uses. */
export function sessionOptionsForAgent(agent: AgentDefinition): Partial<CreateAgentSessionOptions> {
	const options: Partial<CreateAgentSessionOptions> = {
		systemPrompt: agent.systemPrompt,
		toolNames: agent.tools,
		thinkingLevel: agent.thinkingLevel,
	};
	if (agent.spawns !== undefined) options.spawns = agent.spawns === "*" ? "*" : agent.spawns.join(",");
	if (agent.model !== undefined && agent.model.length > 0) options.modelPattern = agent.model;
	return options;
}

/** Opens a headless session for a workspace with per-session options (the headless factory's shape). */
export type HeadlessSessionOpener = (
	cwd: string,
	options: { sessionOptions: Partial<CreateAgentSessionOptions>; interactivePrompts: boolean },
) => Promise<ControlSessionHandle>;

/**
 * Adapt a headless session opener to the control contract. Explicit model
 * selections never fall back; an agent's model patterns replace the launch model.
 */
export function createControlSessionFactory(open: HeadlessSessionOpener): ControlSessionFactory {
	return request => {
		const sessionOptions: Partial<CreateAgentSessionOptions> = request.agent
			? sessionOptionsForAgent(request.agent)
			: {};
		if (request.subagentUi !== undefined) sessionOptions.subagentUi = request.subagentUi;
		if (request.model !== undefined) {
			sessionOptions.model = request.model;
			sessionOptions.disableModelFallback = true;
		} else if (sessionOptions.modelPattern !== undefined) {
			sessionOptions.model = undefined;
		}
		// `ask` is offered only when prompts can reach a human; a control decision is that human.
		return open(request.cwd, { sessionOptions, interactivePrompts: true });
	};
}
