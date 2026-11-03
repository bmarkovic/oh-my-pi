/**
 * Reads a control credential from a file. A credential file that another account can read
 * hands the credential to that account, so the daemon refuses to use one (POSIX only; Windows
 * ACLs are not described by mode bits and are not checked here).
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { logger } from "@oh-my-pi/pi-utils";

/** The parts of `fs.Stats` the permission rule reads, so the rule can be exercised without a file. */
export type CredentialFileStats = Pick<Stats, "mode" | "uid"> & { isFile(): boolean };

/**
 * Why `stats` must not supply a credential, or `undefined` when it may. Refused: a non-regular
 * file, any group or other permission bit, or an owner other than the daemon's user.
 */
export function credentialFileProblem(
	file: string,
	stats: CredentialFileStats,
	platform: NodeJS.Platform,
	uid: number | undefined,
): string | undefined {
	if (platform === "win32") return undefined;
	if (!stats.isFile()) return `credential file ${file} is not a regular file`;
	const permissions = stats.mode & 0o777;
	const ownedByDaemon = uid === undefined || stats.uid === uid;
	if ((permissions & 0o077) === 0 && ownedByDaemon) return undefined;
	const mode = permissions.toString(8).padStart(4, "0");
	return `credential file ${file} must be owned by you and not accessible to group or others (mode ${mode}); run chmod 600 ${file}`;
}

/** Read a credential file: trimmed, non-empty, and only after the permission rule accepts it. */
export async function readCredentialFile(file: string): Promise<string> {
	let stats: Stats;
	try {
		stats = await fs.stat(file);
	} catch {
		throw new Error(`cannot read credential file: ${file}`);
	}
	if (process.platform === "win32") {
		logger.debug("control credential file permissions are not checked on Windows", { file });
	}
	const problem = credentialFileProblem(file, stats, process.platform, process.getuid?.());
	if (problem !== undefined) throw new Error(problem);
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
