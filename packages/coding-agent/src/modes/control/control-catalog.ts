/**
 * Catalog of selections the daemon offers: the models its registry can use and
 * the agent definitions discoverable from a workspace. The wire form exposes ids,
 * names and descriptions only, never prompts or definition paths.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../config/model-registry";
import { discoverAgents } from "../../task/discovery";
import type { AgentDefinition } from "../../task/types";
import type { ControlCatalogAgent, ControlCatalogModel } from "./wire/commands";

/** Source of catalog selections. Tests inject a fixed source; the CLI uses the registry. */
export interface ControlCatalogSource {
	/** Models the daemon can select. */
	models(): readonly Model[];
	/** Agent definitions visible from `cwd`, in discovery order. */
	agents(cwd: string): Promise<readonly AgentDefinition[]>;
}

/** Canonical catalog id of a model: `provider/modelId`. */
export function catalogModelId(model: Pick<Model, "id" | "provider">): string {
	return `${model.provider}/${model.id}`;
}

export interface ControlCatalog {
	agents: ControlCatalogAgent[];
	models: ControlCatalogModel[];
}

/**
 * Build the wire catalog. Names and ids are unique (first occurrence wins). An
 * agent's `defaultModel` is set only when its first model pattern names exactly
 * one catalog id; anything looser is omitted rather than guessed.
 */
export async function buildControlCatalog(source: ControlCatalogSource, cwd: string): Promise<ControlCatalog> {
	const models = uniqueBy(
		source.models().map(model => ({ id: catalogModelId(model), provider: model.provider })),
		m => m.id,
	);
	const modelIds = new Set(models.map(model => model.id));
	const agents = uniqueBy(await source.agents(cwd), agent => agent.name).map(agent => {
		const entry: ControlCatalogAgent = { name: agent.name, description: agent.description, roles: [] };
		const firstPattern = agent.model?.[0];
		if (firstPattern !== undefined && modelIds.has(firstPattern)) entry.defaultModel = firstPattern;
		return entry;
	});
	return { agents, models };
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const item of items) {
		const k = key(item);
		if (seen.has(k)) continue;
		seen.add(k);
		result.push(item);
	}
	return result;
}

/** Catalog source backed by the process model registry and the discovery pipeline. */
export function createRegistryCatalogSource(modelRegistry: ModelRegistry): ControlCatalogSource {
	return {
		models: () => modelRegistry.getAvailable(),
		agents: async cwd => (await discoverAgents(cwd)).agents,
	};
}
