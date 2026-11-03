/**
 * Command operation table. `defineOperation` owns the shared steps every command
 * performs in order: payload validation, the subscription gate, then the handler.
 */
import { OmpErrors, type Type } from "@oh-my-pi/omptype";
import { logger } from "@oh-my-pi/pi-utils";
import { CONTROL_FEATURES } from "./control-features";
import type { ControlConnection, ControlOperationHandler } from "./control-connection";
import { ackFrame, capabilitiesFrame, queryCapabilitiesCommand, subscribeEventsCommand } from "./wire/envelope";

export interface ControlOperationDefinition<C> {
	/** Full payload schema, checked before any side effect. */
	readonly schema: Type<C>;
	/** Refuse with `unsupported_operation` unless `subscribe_events` was accepted on the connection. */
	readonly requiresSubscription?: boolean;
	/**
	 * Performs the command. A handler that awaits must reject only for failures it
	 * could not turn into a typed reply; those are logged and answered with `invalid_message`.
	 */
	readonly run: (connection: ControlConnection, id: string, command: C) => void | Promise<void>;
}

/**
 * Build a handler for one command type. A payload that fails its schema is
 * rejected with `invalid_message` and its diagnostic names only the command type,
 * never payload values, because payloads can carry operator secrets.
 */
export function defineOperation<C>(definition: ControlOperationDefinition<C>): ControlOperationHandler {
	return (connection, id, raw) => {
		const parsed = definition.schema(raw);
		if (parsed instanceof OmpErrors) {
			connection.reject("invalid_message", `malformed ${String(raw.type)} command`, id);
			return;
		}
		if (definition.requiresSubscription && !connection.subscribed) {
			connection.reject("unsupported_operation", "subscribe_events must be accepted before this command", id);
			return;
		}
		const failed = (error: unknown) => {
			logger.error("control command failed", { type: String(raw.type), error: String(error) });
			connection.reject("invalid_message", `${String(raw.type)} could not be completed`, id);
		};
		// A synchronous throw must not escape into the socket's message callback.
		let outcome: void | Promise<void>;
		try {
			outcome = definition.run(connection, id, parsed);
		} catch (error) {
			failed(error);
			return;
		}
		if (outcome !== undefined) outcome.catch(failed);
	};
}

/** Commands available on every build, keyed by wire `type`. */
export const CONTROL_OPERATIONS: ReadonlyMap<string, ControlOperationHandler> = new Map<
	string,
	ControlOperationHandler
>([
	[
		"subscribe_events",
		defineOperation({
			schema: subscribeEventsCommand,
			run: (connection, id) => {
				connection.subscribe();
				connection.reply(ackFrame(id));
			},
		}),
	],
	[
		"query_capabilities",
		defineOperation({
			schema: queryCapabilitiesCommand,
			run: (connection, id) => {
				connection.reply(capabilitiesFrame(id, CONTROL_FEATURES));
			},
		}),
	],
]);
