import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type CredentialFileStats,
	credentialFileProblem,
	readCredentialFile,
} from "../../src/modes/control/control-credential-file";

const SECRET = "file-credential-for-tests";
const OWNER = 1000;

function stats(mode: number, uid = OWNER, isFile = true): CredentialFileStats {
	return { mode: (isFile ? 0o100000 : 0o040000) | mode, uid, isFile: () => isFile };
}

describe("credentialFileProblem", () => {
	it("refuses a credential readable by group or others, naming the path and mode but not the file", () => {
		const problem = credentialFileProblem("/home/op/control.token", stats(0o644), "linux", OWNER);
		expect(problem).toContain("/home/op/control.token");
		expect(problem).toContain("0644");
		expect(problem).toContain("chmod 600");
	});

	it("refuses a group-writable credential, so another account cannot swap it in", () => {
		expect(credentialFileProblem("/t", stats(0o620), "linux", OWNER)).toContain("0620");
	});

	it("accepts an owner-only credential", () => {
		expect(credentialFileProblem("/t", stats(0o600), "linux", OWNER)).toBeUndefined();
		expect(credentialFileProblem("/t", stats(0o400), "darwin", OWNER)).toBeUndefined();
	});

	it("refuses a credential owned by another account even at mode 0600", () => {
		expect(credentialFileProblem("/t", stats(0o600, OWNER + 1), "linux", OWNER)).toContain("must be owned by you");
	});

	it("refuses anything that is not a regular file", () => {
		expect(credentialFileProblem("/run/token", stats(0o600, OWNER, false), "linux", OWNER)).toContain(
			"is not a regular file",
		);
	});

	it("skips the mode check on Windows, where mode bits do not describe ACLs", () => {
		expect(credentialFileProblem("/t", stats(0o644), "win32", OWNER)).toBeUndefined();
	});
});

describe("readCredentialFile", () => {
	it("refuses a group-readable file and never returns or echoes its bytes", async () => {
		const dir = TempDir.createSync("@control-credential-open-");
		try {
			const file = path.join(dir.path(), "control.token");
			await Bun.write(file, `${SECRET}\n`);
			await fs.chmod(file, 0o644);
			const error = await readCredentialFile(file).then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("0644");
			expect((error as Error).message).not.toContain(SECRET);
		} finally {
			await dir.remove();
		}
	});

	it("returns the trimmed credential from an owner-only file", async () => {
		const dir = TempDir.createSync("@control-credential-private-");
		try {
			const file = path.join(dir.path(), "control.token");
			await Bun.write(file, `  ${SECRET}\n`);
			await fs.chmod(file, 0o600);
			expect(await readCredentialFile(file)).toBe(SECRET);
		} finally {
			await dir.remove();
		}
	});

	it("rejects an owner-only file that is empty after trimming", async () => {
		const dir = TempDir.createSync("@control-credential-empty-");
		try {
			const file = path.join(dir.path(), "control.token");
			await Bun.write(file, " \n");
			await fs.chmod(file, 0o600);
			await expect(readCredentialFile(file)).rejects.toThrow("credential file is empty");
		} finally {
			await dir.remove();
		}
	});
});
