/**
 * Feature strings advertised by `query_capabilities`. A feature is listed only
 * once its behavior is implemented, so no build advertises a feature it lacks.
 */
export const CONTROL_FEATURES: readonly string[] = [
	"catalog",
	"steering",
	"usage",
	"interrupt",
	"terminate",
	"tool_bindings",
	"decisions",
	"child_lineage",
];
