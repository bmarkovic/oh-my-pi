/**
 * `omp control serve`: start the daemon, announce its URL on stdout (the only
 * stdout line), and run until SIGINT or SIGTERM. The shutdown runs through the
 * process postmortem registry, which closes the listener and disposes every
 * session before the process exits with the signal's status.
 */
import { postmortem } from "@oh-my-pi/pi-utils";
import type { ControlCatalogSource } from "./control-catalog";
import { ControlDaemon } from "./control-daemon";
import type { ControlSessionFactory } from "./control-session-factory";
import { startControlServer } from "./control-server";

export interface RunControlServeOptions {
	hostname: string;
	port: number;
	bearerTokenFile?: string;
	controlKeyFile?: string;
	bearerToken?: string;
	controlKey?: string;
	catalog: ControlCatalogSource;
	createSession: ControlSessionFactory;
	daemonCwd: string;
}

export async function runControlServe(options: RunControlServeOptions): Promise<void> {
	const daemon = new ControlDaemon({
		catalog: options.catalog,
		createSession: options.createSession,
		daemonCwd: options.daemonCwd,
	});
	const server = await startControlServer({
		hostname: options.hostname,
		port: options.port,
		credentialFiles: { bearerTokenFile: options.bearerTokenFile, controlKeyFile: options.controlKeyFile },
		bearerToken: options.bearerToken,
		controlKey: options.controlKey,
		operations: daemon.operations(),
		onConnection: (principal, opened) => daemon.connectionChanged(principal, opened),
	});
	const stopped = Promise.withResolvers<void>();
	const unregister = postmortem.register("control-serve", async () => {
		try {
			await server.close();
			await daemon.dispose();
		} finally {
			stopped.resolve();
		}
	});
	process.stdout.write(`${server.url}\n`);
	try {
		await stopped.promise;
	} finally {
		unregister();
	}
}
