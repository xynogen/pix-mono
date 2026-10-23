import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateConfig } from "@xynogen/pix-runtime/config";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { editSection } from "@xynogen/pix-runtime/sections";
import registerDiagnostics from "./diagnostics.ts";
import type { LspManager } from "./lsp/manager.ts";
import { isSyntaxError, newSyntaxErrors } from "./syntax-guard.ts";
import type { DiagnosticSnapshot, PixDiagnostic } from "./types.ts";

const diag = (over: Partial<PixDiagnostic>): PixDiagnostic => ({
	filePath: "/x.ts",
	severity: "error",
	message: "';' expected.",
	line: 1,
	column: 1,
	source: "typescript",
	code: 1005,
	...over,
});

describe("syntax error matching", () => {
	test("counts parser errors only", () => {
		expect(isSyntaxError(diag({}))).toBe(true);
		expect(isSyntaxError(diag({ code: 2322, message: "Type 'string' is not assignable" }))).toBe(
			false,
		);
		expect(isSyntaxError(diag({ severity: "warning" }))).toBe(false);
		expect(
			isSyntaxError(diag({ source: "pyright", code: undefined, message: "Expected expression" })),
		).toBe(true);
	});

	test("an error already there before the edit is not new, even on another line", () => {
		const before = [diag({ line: 3 })];
		expect(newSyntaxErrors(before, [diag({ line: 7 })])).toEqual([]);
		expect(newSyntaxErrors(before, [diag({ line: 7 }), diag({ line: 9 })])).toHaveLength(1);
	});
});

describe("edit syntax guard", () => {
	const original = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";
	const broken = "export const a = 1;\nexport const b = (2;\nexport const c = 3;\n";
	let cwd = "";

	afterEach(async () => {
		await updateConfig(editSection, { rejectNewSyntaxErrors: false });
		rmSync(cwd, { recursive: true, force: true });
	});

	async function run(guard: boolean) {
		await updateConfig(editSection, { rejectNewSyntaxErrors: guard });
		cwd = mkdtempSync(join(tempDir(), "pix-guard-"));
		const file = join(cwd, "a.ts");
		writeFileSync(file, original);
		const check = async (): Promise<DiagnosticSnapshot[]> => {
			const text = readFileSync(file, "utf8");
			const diagnostics = text.includes("(2;")
				? [diag({ filePath: file, line: 2, column: 20 })]
				: [];
			return [
				{
					filePath: file,
					diagnostics,
					checkedAt: 0,
					state: diagnostics.length ? "findings" : "clean",
				},
			];
		};
		const manager = {
			check,
			navigate: async () => [],
			activeServerIds: () => [],
			shutdown: async () => {},
		};
		const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
		const pi = {
			on: (name: string, fn: (e: unknown, c: unknown) => unknown) => handlers.set(name, fn),
			registerTool() {},
		};
		registerDiagnostics(pi as never, { manager: manager as unknown as LspManager, cwd });

		const input = { path: "a.ts" };
		await handlers.get("tool_call")?.({ toolName: "edit", toolCallId: "c1", input }, {});
		writeFileSync(file, broken); // the edit tool runs here
		const result = (await handlers.get("tool_result")?.(
			{
				toolName: "edit",
				toolCallId: "c1",
				input,
				content: [{ type: "text", text: "Edited a.ts" }],
				isError: false,
			},
			{},
		)) as { content: Array<{ text: string }>; isError?: boolean };
		return { result, onDisk: readFileSync(file, "utf8") };
	}

	test("on: a new syntax error restores the file and fails with current anchors", async () => {
		const { result, onDisk } = await run(true);
		expect(onDisk).toBe(original);
		expect(result.isError).toBe(true);
		const text = result.content.map((c) => c.text).join("\n");
		expect(text).toMatch(
			/^Edit rejected: it adds 1 syntax error\(s\) to a\.ts\. The file is restored\.\n2:20 1005 ';' expected\./,
		);
		expect(text).toMatch(/\n2#[0-9A-F]{3}\|export const b = 2;\n/);
	});

	test("off (default): the edit stays and only reports diagnostics", async () => {
		const { result, onDisk } = await run(false);
		expect(onDisk).toBe(broken);
		expect(result.isError).toBeUndefined();
		expect(result.content[1]?.text).toMatch(/^LSP after edit:\na\.ts:2:20 error/);
	});
});
