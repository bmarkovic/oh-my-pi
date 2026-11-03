/**
 * The extension UI a control session's tools see. Dialogs that ask a human become
 * decisions; confirmations are denied; presentation calls are ignored, because a
 * control session has no screen.
 */
import type { ExtensionUIContext, ExtensionUISelectItem } from "../../extensibility/extensions/types";
import { noOpUIContext } from "../../extensibility/extensions/runner";
import type { ControlPrincipal } from "./control-auth";
import type { ControlDecisionStore } from "./control-decisions";

export interface ControlUIScope {
	sessionId: string;
	principal: ControlPrincipal;
	decisions: ControlDecisionStore;
	/** The spawning session's handle, when the scoped session is a child. */
	parentSessionId?: string;
}

/** Labels and descriptions of select items, in the order the tool presented them. */
function selectOptions(items: readonly ExtensionUISelectItem[]): Array<{ label: string; description?: string }> {
	return items.map(item => {
		if (typeof item === "string") return { label: item };
		return item.description !== undefined
			? { label: item.label, description: item.description }
			: { label: item.label };
	});
}

export function createControlExtensionUI(scope: ControlUIScope): ExtensionUIContext {
	const ask = (
		question: string,
		options: Array<{ label: string; description?: string }>,
		allowFreeText: boolean,
		signal?: AbortSignal,
	) =>
		scope.decisions.request(scope.sessionId, scope.principal, {
			question,
			options,
			allowFreeText,
			signal,
			parentSessionId: scope.parentSessionId,
		});

	return {
		...noOpUIContext,
		// Steering a control session never answers or cancels its pending question (contract section 4.3).
		keepsDialogsOnSteer: true,
		async select(title, items, dialogOptions) {
			// A control decision answers one option or free text; a multi-select has no such form (note R8).
			if (dialogOptions?.selectionMarker === "checkbox") {
				throw new Error("multi-select questions are not supported in control sessions");
			}
			const options = selectOptions(items);
			const answer = await ask(title, options, false, dialogOptions?.signal);
			if (answer === undefined || !("optionId" in answer)) return undefined;
			const index = Number(answer.optionId);
			return options[index]?.label;
		},
		async input(title, _placeholder, dialogOptions) {
			const answer = await ask(title, [], true, dialogOptions?.signal);
			return answer !== undefined && "text" in answer ? answer.text : undefined;
		},
		async editor(title, _prefill, dialogOptions) {
			const answer = await ask(title, [], true, dialogOptions?.signal);
			return answer !== undefined && "text" in answer ? answer.text : undefined;
		},
		async confirm() {
			return false;
		},
	};
}
