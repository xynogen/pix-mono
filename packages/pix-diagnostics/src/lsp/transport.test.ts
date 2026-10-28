import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { LspTransport, rangedChange } from "./transport.ts";

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

	test("an unversioned publish from the previous edit is never returned as fresh", async () => {
		const client = await startClient(["--unversioned", "--echo", "--delay=700"]);
		try {
			await client.open(filePath, "typescript", "old\n", 1);
			expect((await client.waitForDiagnostics(filePath, 1, 3_000))?.[0]?.message).toBe("old\n");
			await client.change(filePath, "new\n", 2);
			expect((await client.waitForDiagnostics(filePath, 2, 3_000))?.[0]?.message).toBe("new\n");
		} finally {
			await client.stop();
		}
	});

	test("sends only the changed span to an incremental server", async () => {
		const client = await startClient(["--incremental"]);
		try {
			const edited = "line one\r\nline 2 😀!\nline three\nmore\n";
			await client.open(filePath, "typescript", "line one\r\nline two 😀\nline three\n", 1);
			await client.change(filePath, edited, 2);
			const uri = pathToFileURL(filePath).href;
			expect(await client.request<string>("pix/text", { uri })).toBe(edited);
		} finally {
			await client.stop();
		}
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

describe("LspTransport deadlines and failures", () => {
	test("a server that never answers initialize fails start within the deadline", async () => {
		const started = Date.now();
		const start = LspTransport.start({
			command: process.execPath,
			args: [fakeServerPath, "--hang-init"],
			cwd: root,
			rootUri: pathToFileURL(root).href,
			serverId: "fake",
			initTimeoutMs: 300,
		});
		await expect(start).rejects.toThrow(/LSP fake: initialize timed out after \d+s/);
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	test("a missing server binary fails start instead of crashing the host", async () => {
		const start = LspTransport.start({
			command: join(root, "no-such-lsp"),
			args: [],
			cwd: root,
			rootUri: pathToFileURL(root).href,
			serverId: "ghost",
			initTimeoutMs: 2_000,
		});
		await expect(start).rejects.toThrow(/LSP ghost: failed to start: .*ENOENT/);
	});

	test("a request the server never answers hits the local deadline", async () => {
		const client = await LspTransport.start({
			command: process.execPath,
			args: [fakeServerPath],
			cwd: root,
			rootUri: pathToFileURL(root).href,
			serverId: "fake",
			requestTimeoutMs: 200,
		});
		try {
			await expect(client.request("pix/hang", {})).rejects.toThrow(
				/LSP fake: pix\/hang timed out after \d+s/,
			);
		} finally {
			await client.stop();
		}
	});

	test("aborting a pending request rejects at once, without waiting for the server", async () => {
		const client = await startClient();
		try {
			const controller = new AbortController();
			const pending = client.request("pix/hang", {}, controller.signal);
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			await client.stop();
		}
	});
});

afterAll(() => {
	// temp dir cleaned by the OS; nothing persistent to remove
});

describe("rangedChange", () => {
	test("replaces only the differing span, in LSP line/UTF-16 positions", () => {
		expect(rangedChange("ab\ncdef\ngh", "ab\ncXf\ngh")).toEqual({
			range: { start: { line: 1, character: 1 }, end: { line: 1, character: 3 } },
			text: "X",
		});
		expect(rangedChange("same", "same")).toBeUndefined();
	});

	test("never splits a CRLF or surrogate pair", () => {
		expect(rangedChange("a\r\nb", "a\nb")?.range.start).toEqual({ line: 0, character: 1 });
		expect(rangedChange("x😀", "x😃")).toEqual({
			range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } },
			text: "😃",
		});
	});
});
