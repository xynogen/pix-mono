import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { LspTransport } from "./transport.ts";

const root = mkdtempSync(join(tempDir(), "pix-lsp-"));
const fakeServerPath = join(import.meta.dir, "fake-server.fixture.ts");
const filePath = join(root, "a.ts");
writeFileSync(filePath, "const x: number = 'bad';\n");

async function startClient(args: string[] = []): Promise<LspTransport> {
	return LspTransport.start({
		command: process.execPath,
		args: [fakeServerPath, ...args],
		cwd: root,
		rootUri: pathToFileURL(root).href,
		serverId: "fake",
	});
}

describe("LspTransport", () => {
	test("matches encoded Windows drive URIs and confirms empty publishes", async () => {
		const client = await startClient(["--encoded-uri", "--empty"]);
		try {
			const started = Date.now();
			await client.open(filePath, "typescript", "const x = 1;\n", 1);
			expect(await client.waitForDiagnostics(filePath, 1, 2000)).toEqual([]);
			expect(Date.now() - started).toBeLessThan(1500);
			expect(await client.waitForDiagnostics(join(root, "silent.ts"), 1, 100)).toBeUndefined();
		} finally {
			await client.stop();
		}
	});
	test("opens a document and waits for its diagnostics", async () => {
		const client = await startClient();
		await client.open(filePath, "typescript", "const x: number = 'bad';\n", 1);
		const diagnostics = await client.waitForDiagnostics(filePath, 1, 2_000);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics?.[0]?.message).toBe("Type mismatch");
		await client.stop();
		expect(client.state()).toBe("stopped");
	});

	test("aborts one pending wait", async () => {
		const client = await startClient();
		const other = join(root, "never.ts");
		writeFileSync(other, "x\n");
		const controller = new AbortController();
		const wait = client.waitForDiagnostics(other, 5, 10_000, controller.signal);
		controller.abort();
		await expect(wait).rejects.toMatchObject({ name: "AbortError" });
		await client.stop();
	});

	test("waits for the requested version and ignores older events", async () => {
		const client = await startClient();
		await client.open(filePath, "typescript", "const x: number = 'bad';\n", 1);
		await client.waitForDiagnostics(filePath, 1, 2_000);
		await client.change(filePath, "const y: number = 'bad';\n", 2);
		const diagnostics = await client.waitForDiagnostics(filePath, 2, 2_000);
		expect(diagnostics).toHaveLength(1);
		await client.stop();
	});

	test("keeps at most 32 open documents with LRU eviction", async () => {
		const client = await startClient();
		for (let i = 0; i < 33; i++) {
			const p = join(root, `f${i}.ts`);
			await client.open(p, "typescript", "x\n", 1);
		}
		expect(client.openCount()).toBe(32);
		await client.stop();
	});

	test("answers a raw request", async () => {
		const client = await startClient();
		await client.open(filePath, "typescript", "const x = 1;\n", 1);
		const result = await client.request<Array<{ uri: string }>>("textDocument/definition", {
			textDocument: { uri: pathToFileURL(filePath).href },
			position: { line: 0, character: 6 },
		});
		expect(Array.isArray(result)).toBe(true);
		await client.stop();
	});
});

afterAll(() => {
	// temp dir cleaned by the OS; nothing persistent to remove
});
