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
import { assertPrivateCredentialFile, readCredentialFile } from "../modes/control/control-credential-file";
import { bindPolicy } from "../modes/control/control-server";

const DEFAULT_BIND = "127.0.0.1:0";
/** Flags this subcommand consumes; they are removed before the rest of argv reaches the launch parser. */
const CONTROL_VALUE_FLAGS = new Set(["--bind", "--token-file", "--key-file", "--tls-cert", "--tls-key"]);

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
			description:
				"Listen address as host:port (port 0 picks a free port); a non-loopback host needs --tls-cert and --tls-key, and a wildcard address such as 0.0.0.0 is refused",
			default: DEFAULT_BIND,
		}),
		"token-file": Flags.string({
			description:
				"File holding the bearer token, readable only by you (mode 0600), re-read as it changes; or set OMP_CONTROL_TOKEN",
		}),
		"key-file": Flags.string({
			description:
				"File holding the X-Omp-Control-Key value, readable only by you (mode 0600), re-read as it changes; or set OMP_CONTROL_KEY",
		}),
		"tls-cert": Flags.string({ description: "PEM certificate chain: serve wss:// (requires --tls-key)" }),
		"tls-key": Flags.string({ description: "PEM private key for --tls-cert, readable only by you (mode 0600)" }),
	};

	static examples = [
		"# Serve on a free loopback port with a token file\n  omp control serve --token-file ~/.omp/control.token",
		"# Serve with the token from the environment\n  OMP_CONTROL_TOKEN=... omp control serve --bind 127.0.0.1:7077",
		"# Serve on a private interface over TLS\n  omp control serve --bind 10.0.0.5:7077 --tls-cert server.pem --tls-key server.key --token-file ~/.omp/control.token",
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
		const tlsCertFile = flags["tls-cert"];
		const tlsKeyFile = flags["tls-key"];
		if ((tlsCertFile === undefined) !== (tlsKeyFile === undefined)) {
			process.stderr.write("--tls-cert and --tls-key must be given together.\n");
			process.exitCode = 2;
			return;
		}
		const tls =
			tlsCertFile !== undefined && tlsKeyFile !== undefined
				? { certFile: tlsCertFile, keyFile: tlsKeyFile }
				: undefined;
		const bindProblem = bindPolicy(bind.hostname, tls !== undefined);
		if (bindProblem !== undefined) {
			process.stderr.write(`${bindProblem}\n`);
			process.exitCode = 1;
			return;
		}
		if (tls !== undefined) {
			try {
				await assertPrivateCredentialFile(tls.keyFile);
				if (!(await Bun.file(tls.certFile).exists())) {
					throw new Error(`cannot read TLS certificate file: ${tls.certFile}`);
				}
			} catch (error) {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				process.exitCode = 1;
				return;
			}
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
		// File credentials go to the daemon as paths, so rotation is picked up; environment ones are passed as values.
		const bearerTokenFile = flags["token-file"];
		const controlKeyFile = flags["key-file"];
		parsed.controlServe = {
			hostname: bind.hostname,
			port: bind.port,
			bearerTokenFile,
			controlKeyFile,
			bearerToken: bearerTokenFile === undefined ? bearerToken : undefined,
			controlKey: controlKeyFile === undefined ? controlKey : undefined,
			tls,
		};
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

/** A credential from a file (trimmed, must be non-empty) or else from its environment variable, which is then unset. */
export async function readCredential(file: string | undefined, envName: string): Promise<string | undefined> {
	const fromEnv = Bun.env[envName]?.trim();
	// The daemon's credential must not reach agent-spawned processes (bash tool, MCP stdio servers),
	// which inherit this process's environment: contract section 6 keeps control secrets from agents.
	delete Bun.env[envName];
	if (file === undefined) return fromEnv ? fromEnv : undefined;
	return readCredentialFile(file);
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
