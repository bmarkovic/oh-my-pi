import { describe, expect, it } from "bun:test";
import {
	ControlConnection,
	type ControlOperationHandler,
	type ControlSocket,
} from "../../src/modes/control/control-connection";
import { collectServerFrames, maskedTextFrame, silentUpgradedSocket, startTestDaemon, textFrameJson } from "./harness";

const TIMING = { helloTimeoutMs: 60_000, pingIntervalMs: 60_000, livenessTimeoutMs: 60_000 };
const KIB = 1024;

/** A transport whose buffer and send status the test controls. */
function congestibleSocket() {
	const state = { buffered: 0, sendStatus: -1 };
	const sent: string[] = [];
	const socket = {
		send: (text: string) => {
			sent.push(text);
			return state.sendStatus;
		},
		bufferedAmount: () => state.buffered,
		close: (_code: number, _reason: string) => {},
		ping: () => {},
		terminate: () => {},
	} satisfies ControlSocket;
	return { socket, state, sent };
}

describe("control connection outbound queue", () => {
	it("holds frames behind a congested transport and sends them in order once it drains", () => {
		const { socket, state, sent } = congestibleSocket();
		const connection = new ControlConnection({
			socket,
			principal: "bearer",
			timing: TIMING,
			operations: new Map<string, ControlOperationHandler>(),
			outbound: { highWaterBytes: KIB, queueLimitBytes: 1024 * KIB },
		});
		state.buffered = 2 * KIB * KIB;
		connection.reply({ n: 1 });
		connection.reply({ n: 2 });
		expect(sent).toEqual([]);

		state.buffered = 0;
		connection.reply({ n: 3 });
		// The third frame arrived after the transport drained, but it still waits behind the queued ones.
		expect(sent).toEqual([]);
		connection.flush();
		expect(sent.map(text => JSON.parse(text).n)).toEqual([1, 2, 3]);
		connection.dispose();
	});

	it("closes with 1013 when the backlog exceeds its bound, and sends nothing after that", () => {
		const { socket, state, sent } = congestibleSocket();
		const closes: Array<{ code: number; reason: string }> = [];
		const connection = new ControlConnection({
			socket: { ...socket, close: (code, reason) => closes.push({ code, reason }) },
			principal: "bearer",
			timing: TIMING,
			operations: new Map<string, ControlOperationHandler>(),
			outbound: { highWaterBytes: KIB, queueLimitBytes: KIB },
		});
		state.buffered = 2 * KIB * KIB;
		const payload = "x".repeat(400);
		connection.reply({ n: 1, payload });
		connection.reply({ n: 2, payload });
		connection.reply({ n: 3, payload });
		connection.reply({ n: 4, payload });

		expect(closes).toEqual([{ code: 1013, reason: "outbound backlog exceeded" }]);
		state.buffered = 0;
		connection.flush();
		expect(sent).toEqual([]);
		connection.dispose();
	});
});

describe("control daemon under a slow reader", () => {
	it("delivers a gap-free prefix of its frames and then closes 1013, rather than dropping frames silently", async () => {
		const FRAMES = 400;
		const PADDING = "x".repeat(64 * KIB);
		const flood: ControlOperationHandler = (connection, id) => {
			for (let index = 0; index < FRAMES; index++) {
				connection.reply({ version: 2, inReplyTo: id, type: "flood_frame", index, padding: PADDING });
			}
		};
		const daemon = await startTestDaemon({
			operations: new Map([["flood", flood]]),
			outbound: { highWaterBytes: 64 * KIB, queueLimitBytes: 256 * KIB },
		});
		try {
			// The raw socket is upgraded and then never read until the flood has been produced.
			const socket = await silentUpgradedSocket(daemon.url, daemon.bearerHeaders);
			const encode = (frame: object) => maskedTextFrame(new TextEncoder().encode(JSON.stringify(frame)));
			socket.write(encode({ version: 2, id: "hello-1", type: "hello", supportedVersions: [2] }));
			socket.write(encode({ version: 2, id: "flood-1", type: "flood" }));
			await Bun.sleep(300);

			const frames = await collectServerFrames(socket);
			const last = frames.at(-1);
			expect(last?.opcode).toBe(0x8);
			expect(last?.payload.readUInt16BE(0)).toBe(1013);
			expect(last?.payload.subarray(2).toString("utf8")).toBe("outbound backlog exceeded");

			const texts = frames.filter(frame => frame.opcode === 0x1).map(textFrameJson);
			expect(texts[0]).toMatchObject({ type: "welcome", inReplyTo: "hello-1" });
			const delivered = texts.slice(1).map(frame => frame.index);
			expect(delivered.length).toBeGreaterThan(0);
			expect(delivered.length).toBeLessThan(FRAMES);
			expect(delivered).toEqual(Array.from({ length: delivered.length }, (_unused, position) => position));
		} finally {
			await daemon.close();
		}
	}, 20_000);
});
