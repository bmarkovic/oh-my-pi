/**
 * `omp control serve`: run the OMP v2 control daemon for a control-plane client.
 * Credentials come from `--token-file` / `--key-file`, or from `OMP_CONTROL_TOKEN` /
 * `OMP_CONTROL_KEY`. The launch's other flags (for example `--approval-mode`) apply
 * to the sessions the daemon creates.
 */

import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { type Args as ParsedArgs, parseArgs, reportCliUsageError } from "../cli/args";
import { controlHelp as commandHelp } from "../cli/command-help";
import { runRootCommand } from "../main";
import { isLoopbackHost } from "../modes/control/control-server";

const DEFAULT_BIND = "127.0.0.1:0";
/** Flags this subcommand consumes; they are removed before the rest of argv reaches the launch parser. */
const CONTROL_VALUE_FLAGS = new Set(["--bind", "--token-file", "--key-file"]);

export default class Control extends Command {
	static description = commandHelp.description;
	static strict = false;
	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: ["serve"],
		}),
	};

	static flags = {
		bind: Flags.string({
			description: "Loopback listen address as host:port (port 0 picks a free port)",
			default: DEFAULT_BIND,
		}),
		"token-file": Flags.string({ description: "File holding the bearer token (or set OMP_CONTROL_TOKEN)" }),
		"key-file": Flags.string({ description: "File holding the X-Omp-Control-Key value (or set OMP_CONTROL_KEY)" }),
	};

	static examples = [
		"# Serve on a free loopback port with a token file\n  omp control serve --token-file ~/.omp/control.token",
		"# Serve with the token from the environment\n  OMP_CONTROL_TOKEN=... omp control serve --bind 127.0.0.1:7077",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Control);
		if (args.action !== "serve") {
			renderCommandHelp("omp", "control", Control);
			return;
		}

		const bind = parseBind(flags.bind ?? DEFAULT_BIND);
		if (bind === undefined) {
			process.stderr.write(`Invalid --bind value: ${JSON.stringify(flags.bind)}. Expected host:port.\n`);
			process.exitCode = 2;
			return;
		}
		if (!isLoopbackHost(bind.hostname)) {
			process.stderr.write(
				`--bind must be a loopback address; remote control requires TLS, which is not available.\n`,
			);
			process.exitCode = 1;
			return;
		}

		let bearerToken: string | undefined;
		let controlKey: string | undefined;
		try {
			bearerToken = await readCredential(flags["token-file"], "OMP_CONTROL_TOKEN");
			controlKey = await readCredential(flags["key-file"], "OMP_CONTROL_KEY");
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
			return;
		}
		if (bearerToken === undefined && controlKey === undefined) {
			process.stderr.write(
				"omp control serve needs a credential: pass --token-file or --key-file, or set OMP_CONTROL_TOKEN or OMP_CONTROL_KEY.\n",
			);
			process.exitCode = 1;
			return;
		}

		let parsed: ParsedArgs;
		const launchArgs = stripControlArgs(this.argv);
		try {
			parsed = parseArgs(launchArgs);
		} catch (error) {
			if (reportCliUsageError(error)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}
		parsed.mode = "control";
		parsed.controlServe = { hostname: bind.hostname, port: bind.port, bearerToken, controlKey };
		await runRootCommand(parsed, launchArgs);
	}
}

/** Split `host:port` (IPv6 hosts may be bracketed). Returns `undefined` for anything else. */
export function parseBind(value: string): { hostname: string; port: number } | undefined {
	const separator = value.lastIndexOf(":");
	if (separator <= 0) return undefined;
	const hostname = value.slice(0, separator).replace(/^\[(.*)\]$/, "$1");
	const portText = value.slice(separator + 1);
	if (!/^\d+$/.test(portText)) return undefined;
	const port = Number(portText);
	if (port > 65_535) return undefined;
	return { hostname, port };
}

/** A credential from a file (trimmed, must be non-empty) or else from its environment variable. */
async function readCredential(file: string | undefined, envName: string): Promise<string | undefined> {
	if (file !== undefined) {
		let text: string;
		try {
			text = await Bun.file(file).text();
		} catch {
			throw new Error(`cannot read credential file: ${file}`);
		}
		const value = text.trim();
		if (value.length === 0) throw new Error(`credential file is empty: ${file}`);
		return value;
	}
	const fromEnv = Bun.env[envName]?.trim();
	return fromEnv ? fromEnv : undefined;
}

/** Remove the subcommand action and this subcommand's flags from argv, keeping everything else. */
export function stripControlArgs(argv: readonly string[]): string[] {
	const kept: string[] = [];
	let droppedAction = false;
	let skipValue = false;
	for (const token of argv) {
		if (skipValue) {
			skipValue = false;
			continue;
		}
		if (!droppedAction && token === "serve") {
			droppedAction = true;
			continue;
		}
		if (token.startsWith("--")) {
			const name = token.split("=", 1)[0];
			if (CONTROL_VALUE_FLAGS.has(name)) {
				skipValue = !token.includes("=");
				continue;
			}
		}
		kept.push(token);
	}
	return kept;
}
