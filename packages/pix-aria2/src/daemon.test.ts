/**
 * Test the live daemon when pix-runtime resolves aria2c.
 * Otherwise, test the missing-binary error without a network download.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { resolveTool } from "@xynogen/pix-runtime/binaries";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { aria2 } from "maria2";
import { type DaemonHandle, startDaemon } from "./daemon.ts";

const binary = resolveTool("aria2c");
const PAYLOAD = Buffer.from("pix-aria2 e2e payload ".repeat(1000)); // ~25 KiB

let fileServer: Server;
let fileUrl: string;
let dir: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tempDir(), "dl-e2e-"));
	fileServer = createServer((_req, res) => {
		res.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": PAYLOAD.length,
		});
		res.end(PAYLOAD);
	});
	await new Promise<void>((r) => fileServer.listen(0, "127.0.0.1", r));
	const addr = fileServer.address();
	const port = addr && typeof addr === "object" ? addr.port : 0;
	fileUrl = `http://127.0.0.1:${port}/payload.bin`;
});

afterAll(() => {
	fileServer?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

if (binary)
	describe("startDaemon (live)", () => {
		let daemon: DaemonHandle;

		afterAll(async () => {
			await daemon?.shutdown();
		});

		test("spawns, connects, and reports a version", async () => {
			daemon = await startDaemon({ dir });
			expect(daemon.port).toBeGreaterThan(0);
			expect(daemon.secret).toHaveLength(32);
			const version = await aria2.getVersion(daemon.conn);
			expect(version.version).toBeTruthy();
		});

		test("downloads a file end to end", async () => {
			const gid = (await aria2.addUri(daemon.conn, [fileUrl])) as string;
			expect(gid).toBeTruthy();
			// Poll until aria2 reports the download complete.
			let done = false;
			for (let i = 0; i < 50 && !done; i++) {
				const s = await aria2.tellStatus(daemon.conn, gid, [
					"status",
					"completedLength",
					"totalLength",
				]);
				done = s.status === "complete";
				if (!done) await new Promise((r) => setTimeout(r, 100));
			}
			expect(done).toBe(true);
			const written = readFileSync(join(dir, "payload.bin"));
			expect(written.length).toBe(PAYLOAD.length);
		});
	});
else
	test("reports the install hint when aria2c is unavailable", async () => {
		const offline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		try {
			await expect(startDaemon({ dir })).rejects.toMatchObject({
				name: "BinaryMissingError",
				tool: "aria2c",
				state: "missing",
				hint: expect.any(String),
			});
		} finally {
			if (offline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = offline;
		}
	});
