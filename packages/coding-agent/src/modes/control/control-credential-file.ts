/**
 * Reads a control credential from a file. A credential file that another account can read
 * hands the credential to that account, so the daemon refuses to use one (POSIX only; Windows
 * ACLs are not described by mode bits and are not checked here).
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { logger } from "@oh-my-pi/pi-utils";
import type { ControlCredentials } from "./control-auth";

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

/** Credential files for a daemon run: each named file supplies one principal's credential. */
export interface ControlCredentialFiles {
	bearerTokenFile?: string;
	controlKeyFile?: string;
}

interface WatchedCredential {
	readonly kind: "bearerToken" | "controlKey";
	readonly file: string;
	/** Fingerprint of the file at its last read; `MISSING_STAMP` when it did not exist. */
	stamp: string;
	/** The credential, or `undefined` while the file is missing or refused (its principal is then disabled). */
	value: string | undefined;
}

const MISSING_STAMP = "missing";

/** Stat fingerprint: any replacement, rewrite or permission change alters at least one field. */
async function fileStamp(file: string): Promise<string> {
	try {
		const stats = await fs.stat(file);
		return `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.mode}`;
	} catch {
		return MISSING_STAMP;
	}
}

/**
 * Keeps the daemon's file-backed credentials current. Each file is stat-polled; a changed file is
 * re-read through `readCredentialFile`. Failure closes the principal (its upgrades get 401) until
 * a valid file reappears, so deleting a credential file revokes it. Messages name paths, never bytes.
 */
export class ControlCredentialWatch {
	readonly #entries: WatchedCredential[];
	readonly #pollMs: number;
	#timer: Timer | undefined;
	#polling = false;

	constructor(files: ControlCredentialFiles, pollMs: number) {
		const entries: WatchedCredential[] = [];
		if (files.bearerTokenFile !== undefined) {
			entries.push({ kind: "bearerToken", file: files.bearerTokenFile, stamp: MISSING_STAMP, value: undefined });
		}
		if (files.controlKeyFile !== undefined) {
			entries.push({ kind: "controlKey", file: files.controlKeyFile, stamp: MISSING_STAMP, value: undefined });
		}
		this.#entries = entries;
		this.#pollMs = pollMs;
	}

	/** Read every configured file once. Throws, before anything is served, if one cannot supply a credential. */
	async load(): Promise<void> {
		for (const entry of this.#entries) {
			entry.stamp = await fileStamp(entry.file);
			entry.value = await readCredentialFile(entry.file);
		}
	}

	/** The credentials as of the last poll. */
	current(): ControlCredentials {
		const credentials: ControlCredentials = {};
		for (const entry of this.#entries) credentials[entry.kind] = entry.value;
		return credentials;
	}

	/** Start polling. The timer is unref'd, so it never keeps the process alive. */
	start(): void {
		if (this.#timer !== undefined) return;
		this.#timer = setInterval(() => void this.#pollOnce(), this.#pollMs);
		this.#timer.unref();
	}

	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	async #pollOnce(): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			for (const entry of this.#entries) await this.#sync(entry);
		} finally {
			this.#polling = false;
		}
	}

	async #sync(entry: WatchedCredential): Promise<void> {
		const stamp = await fileStamp(entry.file);
		if (stamp === entry.stamp) return;
		entry.stamp = stamp;
		if (stamp === MISSING_STAMP) {
			entry.value = undefined;
			logger.warn("control credential file is missing; its upgrades are refused until it is restored", {
				kind: entry.kind,
				file: entry.file,
			});
			return;
		}
		try {
			entry.value = await readCredentialFile(entry.file);
			logger.debug("control credential reloaded", { kind: entry.kind, file: entry.file });
		} catch (error) {
			entry.value = undefined;
			logger.warn("control credential file is unusable; its upgrades are refused until it is fixed", {
				kind: entry.kind,
				file: entry.file,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
