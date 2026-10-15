import { expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tempDir } from "@xynogen/pix-runtime/paths";
import type { SgNode } from "../engine.ts";

// ponytail: synthetic parser nodes check outline selection without installing a Python grammar.
function node(kind: string, text: string, line: number, children: SgNode[] = []): SgNode {
	return {
		kind: () => kind,
		text: () => text,
		range: () => ({ start: { line, column: 0, index: 0 }, end: { line, column: 0, index: 0 } }),
		children: () => children,
	} as SgNode;
}

mock.module("../grammars.ts", () => ({
	grammarCacheDir: () => join(tempDir(), "pix-outline-grammar-cache"),
	parseWithGrammar: async () => ({
		kind: "ok",
		root: node("module", "", 0, [
			node("import_from_statement", "from math import sqrt", 0),
			node("function_definition", "def plain(): pass", 2, [node("identifier", "plain", 2)]),
			node("class_definition", "class Widget: pass", 4, [node("identifier", "Widget", 4)]),
			node("decorated_definition", "@cache\ndef cached(): pass", 6, [
				node("decorator", "@cache", 6),
				node("function_definition", "def cached(): pass", 7, [node("identifier", "cached", 7)]),
			]),
		]),
	}),
}));

const { registerOutlineTool } = await import("./outline-tool.ts");

test("Python outline lists imports, functions, classes and decorated definitions", async () => {
	const cwd = mkdtempSync(join(tempDir(), "pix-outline-"));
	writeFileSync(join(cwd, "a.py"), "# parser fixture\n");
	let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
	registerOutlineTool(
		{
			registerTool: (definition) => {
				tool = definition as unknown as typeof tool;
			},
		} as ExtensionAPI,
		{ cwd },
	);
	if (!tool) throw new Error("tool missing");
	const result = await tool.execute("t", { path: "." }, undefined, undefined, {} as never);
	expect(result.details).toMatchObject({ outcome: "success", symbols: 4 });
	const text = result.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n");
	expect(text).toMatch(
		/a\.py\n {2}1: import_from_statement[\s\S]*3: function_definition {2}plain[\s\S]*5: class_definition {2}Widget[\s\S]*8: function_definition {2}cached/,
	);
});
