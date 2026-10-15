import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@xynogen/pix-runtime/paths";
import type { LspManager, NavigationRequest, NavigationResult } from "../lsp/manager.ts";
import { methodFor } from "../lsp/manager.ts";
import { registerNavigationTool } from "./navigation-tool.ts";

type ToolDef = {
	name: string;
	description: string;
	promptSnippet: string;
	parameters: { properties: Record<string, unknown> };
	execute: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: Array<{ text: string }>; isError?: boolean; details?: unknown }>;
};

function fakeManager(results: NavigationResult[]): LspManager & { calls: NavigationRequest[] } {
	const calls: NavigationRequest[] = [];
	return {
		calls,
		async check() {
			return [];
		},
		async navigate(request: NavigationRequest) {
			calls.push(request);
			return results.slice(0, request.limit);
		},
		activeServerIds: () => [],
		async shutdown() {},
	};
}

function capture(manager: LspManager, cwd = "/repo"): ToolDef {
	let tool: ToolDef | null = null;
	const pi = {
		registerTool(def: ToolDef) {
			tool = def;
		},
	} as never;
	registerNavigationTool(pi, { manager, cwd });
	if (!tool) throw new Error("tool not registered");
	return tool;
}

describe("lsp_navigation tool", () => {
	test("has exactly the nine public fields in order", () => {
		const tool = capture(fakeManager([]));
		const { name, description, promptSnippet, parameters } = tool;
		expect(
			Buffer.byteLength(JSON.stringify({ name, description, promptSnippet, parameters })),
		).toBeLessThanOrEqual(1100);
		expect(Object.keys(tool.parameters.properties)).toEqual([
			"operation",
			"path",
			"line",
			"character",
			"symbol",
			"query",
			"newName",
			"direction",
			"limit",
		]);
	});

	test("maps operations to LSP methods", () => {
		expect(methodFor("definition")).toBe("textDocument/definition");
		expect(methodFor("references")).toBe("textDocument/references");
		expect(methodFor("hover")).toBe("textDocument/hover");
		expect(methodFor("workspaceSymbol")).toBe("workspace/symbol");
		expect(methodFor("rename")).toBe("textDocument/rename");
		expect(methodFor("callHierarchy")).toBe("textDocument/prepareCallHierarchy");
	});

	test("a file operation needs a path", async () => {
		const tool = capture(fakeManager([]));
		await expect(
			tool.execute("t", { operation: "definition", line: 1, character: 1 }),
		).rejects.toThrow(/path/);
	});

	test("a file operation needs a position or symbol", async () => {
		const root = mkdtempSync(join(tempDir(), "pix-nav-"));
		const file = join(root, "a.ts");
		writeFileSync(file, "const value = 1;\n");
		const tool = capture(fakeManager([]), root);
		await expect(tool.execute("t", { operation: "definition", path: "a.ts" })).rejects.toThrow(
			/position|symbol/,
		);
	});

	test("workspaceSymbol needs a query and no path", async () => {
		const manager = fakeManager([{ kind: "symbol", name: "Foo", symbolKind: 5 }]);
		const tool = capture(manager);
		await tool.execute("t", { operation: "workspaceSymbol", query: "Foo" });
		expect(manager.calls[0]?.query).toBe("Foo");
	});

	test("resolves a symbol to a position on the named line", async () => {
		const root = mkdtempSync(join(tempDir(), "pix-nav-"));
		const file = join(root, "a.ts");
		writeFileSync(file, "const target = 1;\n");
		const manager = fakeManager([{ kind: "location", filePath: file, line: 1, character: 7 }]);
		const tool = capture(manager, root);
		await tool.execute("t", { operation: "definition", path: "a.ts", line: 1, symbol: "target" });
		expect(manager.calls[0]?.character).toBe(7);
	});

	test("clamps results to the limit", async () => {
		const many: NavigationResult[] = Array.from({ length: 300 }, (_, i) => ({
			kind: "location" as const,
			filePath: `/repo/f${i}.ts`,
			line: 1,
			character: 1,
		}));
		const manager = fakeManager(many);
		const tool = capture(manager);
		const result = await tool.execute("t", { operation: "workspaceSymbol", query: "x" });
		const details = result.details as { results: number };
		expect(details.results).toBeLessThanOrEqual(200);
	});

	test("caps hover text and marks it truncated", async () => {
		const bigHover = "x".repeat(5000);
		const manager = fakeManager([{ kind: "hover", text: bigHover }]);
		const root = mkdtempSync(join(tempDir(), "pix-nav-"));
		const file = join(root, "a.ts");
		writeFileSync(file, "const value = 1;\n");
		const tool = capture(manager, root);
		const result = await tool.execute("t", {
			operation: "hover",
			path: "a.ts",
			line: 1,
			character: 7,
		});
		const details = result.details as { truncated: boolean };
		expect(details.truncated).toBe(true);
		expect(result.content[0]?.text.length).toBeLessThanOrEqual(4096 + 32);
	});

	test("rename requires newName and passes it through", async () => {
		const manager = fakeManager([
			{
				kind: "edit",
				filePath: "/repo/a.ts",
				line: 1,
				character: 7,
				endLine: 1,
				endCharacter: 13,
				newText: "renamed",
			},
		]);
		const tool = capture(manager);
		await expect(
			tool.execute("t", { operation: "rename", path: "a.ts", line: 1, character: 7 }),
		).rejects.toThrow("newName");
		const res = await tool.execute("t", {
			operation: "rename",
			path: "a.ts",
			line: 1,
			character: 7,
			newName: "renamed",
		});
		expect(manager.calls.at(-1)?.newName).toBe("renamed");
		expect(res.content[0]?.text).toContain("renamed");
	});

	test("callHierarchy defaults to incoming direction", async () => {
		const manager = fakeManager([
			{ kind: "call", name: "caller", filePath: "/repo/b.ts", line: 4, character: 2 },
		]);
		const tool = capture(manager);
		const res = await tool.execute("t", {
			operation: "callHierarchy",
			path: "a.ts",
			line: 1,
			character: 1,
		});
		expect(manager.calls.at(-1)?.direction).toBe("incoming");
		expect(res.content[0]?.text).toContain("caller");
	});
});
