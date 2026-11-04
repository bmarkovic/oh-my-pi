import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ControlChildLedger } from "@oh-my-pi/pi-coding-agent/modes/control/control-children";
import { ControlDecisionStore } from "@oh-my-pi/pi-coding-agent/modes/control/control-decisions";
import {
	type ControlSessionRecord,
	ControlSessionRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/control/control-session-registry";
import type { ControlEvent } from "@oh-my-pi/pi-coding-agent/modes/control/wire/events";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** The slice of an agent session the child ledger reads and drives. */
class FakeChildSession {
	lastAssistant: AssistantMessage | undefined;
	isStreaming = false;
	readonly agent = { hasQueuedMessages: () => false };
	readonly sessionManager = {
		getUsageStatistics: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
	};
	readonly #listeners = new Set<(event: { type: string; isTerminal?: boolean }) => void>();

	getLastAssistantMessage(): AssistantMessage | undefined {
		return this.lastAssistant;
	}
	subscribe(listener: (event: { type: string; isTerminal?: boolean }) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	emit(event: { type: string; isTerminal?: boolean }): void {
		for (const listener of [...this.#listeners]) listener(event);
	}
	async abort(): Promise<void> {}
	async dispose(): Promise<void> {}
	async waitForIdle(): Promise<void> {}
}

function abortedMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "aborted",
		errorMessage: "Request was aborted",
	} as unknown as AssistantMessage;
}

function parentRecord(session: FakeChildSession): ControlSessionRecord {
	return {
		sessionId: "parent",
		principal: "bearer",
		taskRef: "task",
		timeoutMs: 60_000,
		state: "active",
		session: session as unknown as AgentSession,
		tools: [],
		lane: Promise.resolve(),
		rootSessionId: "parent",
		children: [],
	};
}

describe("control child ledger", () => {
	it("publishes only session_terminated for a child whose parent is being hard-stopped", async () => {
		const published: ControlEvent[] = [];
		const registry = new ControlSessionRegistry();
		const ledger = new ControlChildLedger({
			publish: (_principal, event) => {
				published.push(event);
				return event;
			},
			decisions: new ControlDecisionStore((_principal, event) => event, 60_000),
			registry,
		});
		const parent = parentRecord(new FakeChildSession());
		parent.turn = {
			operatorUserId: undefined,
			usageBaseline: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			assistantBaseline: undefined,
			stop: undefined,
			settled: false,
			deadline: undefined,
		};
		registry.register(parent);
		const childSession = new FakeChildSession();
		ledger.adopt(parent, childSession as unknown as AgentSession, "child");

		// The hard stop is requested; aborting the parent's tool aborts the child's run, which reports
		// its end before the parent has unwound and the ledger tears the children down.
		parent.turn.stop = "terminate";
		childSession.lastAssistant = abortedMessage();
		childSession.emit({ type: "agent_end", isTerminal: true });
		await Bun.sleep(20);
		await ledger.terminateChildren(parent);

		expect(published.map(event => `${event.type}:${event.sessionId}`)).toEqual([
			"session_started:child",
			"session_terminated:child",
		]);
	});
});
