import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { connectClient, handshake } from "./harness";

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");

function spawnControl(home: string, env: Record<string, string>): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	return Bun.spawn([process.execPath, CLI, "control", "serve"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...Bun.env, HOME: home, OMP_CONTROL_TOKEN: "", OMP_CONTROL_KEY: "", ...env },
	});
}

/** Read stdout until the first newline, returning the line without it. */
async function readFirstLine(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (!text.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`stdout closed before a line: ${JSON.stringify(text)}`);
		text += decoder.decode(value, { stream: true });
	}
	reader.releaseLock();
	return text.slice(0, text.indexOf("\n"));
}

/** Whatever stdout arrives within `windowMs`; anything other than the announced line is a protocol fault. */
async function readAvailableStdout(child: Bun.Subprocess<"ignore", "pipe", "pipe">, windowMs: number): Promise<string> {
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Bun.sleep(windowMs).then(() => undefined);
	while (true) {
		const next = await Promise.race([reader.read(), deadline]);
		if (next === undefined || next.done) break;
		text += decoder.decode(next.value, { stream: true });
	}
	reader.releaseLock();
	return text;
}

describe("omp control serve", () => {
	it("exits 1 with a message on stderr when no credential is configured", async () => {
		const home = TempDir.createSync("@control-cli-none-");
		try {
			const child = spawnControl(home.path(), {});
			const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(code).toBe(1);
			expect(stderr).toContain("needs a credential");
		} finally {
			await home.remove();
		}
	});

	it("prints exactly one ws URL line, accepts an authenticated hello and exits with the SIGTERM status after closing the listener", async () => {
		const home = TempDir.createSync("@control-cli-token-");
		const child = spawnControl(home.path(), { OMP_CONTROL_TOKEN: "cli-token-for-tests" });
		let announcedUrl = "";
		try {
			const line = await readFirstLine(child);
			announcedUrl = line;
			expect(line).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/control$/);
			expect(await readAvailableStdout(child, 300)).toBe("");
			const client = await connectClient(line, { Authorization: "Bearer cli-token-for-tests" });
			try {
				expect(await handshake(client)).toMatchObject({ type: "welcome", selectedVersion: 2 });
			} finally {
				client.close();
			}
		} finally {
			child.kill("SIGTERM");
			// 128 + SIGTERM: the postmortem shutdown closed the listener, then exited with the signal status.
			expect(await child.exited).toBe(143);
			await expect(connectClient(announcedUrl, { Authorization: "Bearer cli-token-for-tests" })).rejects.toThrow();
			await home.remove();
		}
	}, 30_000);
});
