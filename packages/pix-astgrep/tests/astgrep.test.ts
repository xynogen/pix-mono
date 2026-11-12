/**
 * astgrep.test.ts — one behavior check per tool over a temp fixture tree.
 *
 * These run the real @ast-grep/napi engine. No fake, no network. Each test
 * captures the registered tool and calls its execute against files on disk.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecuteCtx } from "@xynogen/pix-pretty/grammar-consent";
import { tempDir } from "@xynogen/pix-runtime/paths";
import registerAstGrep from "../src/astgrep.ts";

interface Tool {
	name: string;
	description: string;
	promptSnippet: string;
	parameters: { properties: Record<string, unknown>; required?: string[] };
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: ExecuteCtx,
	) => Promise<{ content: Array<{ text: string }>; details?: unknown; isError?: boolean }>;
}

/** The single `ast` tool, keyed by action; each entry's execute adds that `action`. */
function capture(cwd: string): Map<string, Tool> {
	let ast: Tool | undefined;
	const pi = {
		on() {},
		registerTool(def: Tool) {
			ast = def;
		},
	};
	const prev = process.cwd();
	process.chdir(cwd);
	registerAstGrep(pi as never);
	process.chdir(prev);
	if (!ast) throw new Error("ast tool not registered");
	const tool = ast;
	const actions = (tool.parameters.properties.action as { enum: string[] }).enum;
	return new Map(
		actions.map((action) => [
			action,
			{
				...tool,
				execute: (id, params, signal, onUpdate, ctx) =>
					tool.execute(id, { action, ...params }, signal, onUpdate, ctx),
			},
		]),
	);
}

function fixture(): string {
	const dir = mkdtempSync(join(tempDir(), "pix-astgrep-"));
	writeFileSync(
		join(dir, "a.ts"),
		[
			"export function greet(name: string): string {",
			"  return 'hi ' + name;",
			"}",
			"const x = greet('a');",
			"const y = greet('b');",
		].join("\n"),
	);
	writeFileSync(join(dir, "b.ts"), "export class Widget {}\nconst w = new Widget();\n");
	return dir;
}

describe("pix-astgrep tools", () => {
	for (const name of ["symbol", "enclosing"]) {
		test(`${name} caps multilingual source at a complete UTF-8 boundary`, async () => {
			const dir = fixture();
			const source = `function greet() { return "${"a😀é中".repeat(4000)}"; }`;
			writeFileSync(join(dir, "a.ts"), source);
			const tool = capture(dir).get(name);
			if (!tool) throw new Error("tool missing");
			const result = await tool.execute("t", { path: "a.ts", symbol: "greet", line: 1 });
			const body = (result.content[0]?.text ?? "").split("\n").slice(1).join("\n");
			expect(result.details).toMatchObject({ truncated: true });
			expect(Buffer.byteLength(body)).toBeGreaterThan(16380);
			expect(Buffer.byteLength(body)).toBeLessThanOrEqual(16384);
			expect(source.startsWith(body)).toBe(true);
		});
	}

	test("registers one ast tool with the six actions", () => {
		const tools = capture(fixture());
		expect([...tools.keys()]).toEqual([
			"outline",
			"symbol",
			"enclosing",
			"search",
			"replace",
			"symbols",
		]);
		expect(tools.get("outline")?.name).toBe("ast");
	});

	test("AST contract stays bounded while preserving pattern and write controls", () => {
		const tool = capture(fixture()).get("search");
		if (!tool) throw new Error("tool missing");
		const { name, description, promptSnippet, parameters } = tool;
		// Six former tools were capped at 1,250 bytes each; one merged tool stays well below their sum.
		expect(
			Buffer.byteLength(JSON.stringify({ name, description, promptSnippet, parameters })),
		).toBeLessThanOrEqual(3500);
		expect(parameters.required).toEqual(["action"]);
		const props = parameters.properties as Record<string, { description?: string }>;
		expect(props.pattern?.description).toStartWith("[search REQUIRED|replace REQUIRED]");
		expect(props.rewrite?.description).toStartWith("[replace REQUIRED]");
		expect(props.pattern).toMatchObject({
			anyOf: [{ type: "string" }, { type: "object", required: ["context", "selector"] }],
		});
		expect(props.apply).toMatchObject({ type: "boolean" });
	});

	test("ast outline lists top-level declarations with line numbers", async () => {
		const dir = fixture();
		const tool = capture(dir).get("outline");
		if (!tool) throw new Error("tool missing");
		const res = await tool.execute("t", { path: "." });
		expect((res.details as { symbols: number }).symbols).toBeGreaterThanOrEqual(2);
		expect(res.content[0]?.text).toContain("greet");
		expect(res.content[0]?.text).toContain("Widget");
	});

	test("ast enclosing returns the symbol covering a line", async () => {
		const dir = fixture();
		const tool = capture(dir).get("enclosing");
		if (!tool) throw new Error("tool missing");
		// Line 2 is inside greet's body.
		const res = await tool.execute("t", { path: "a.ts", line: 2 });
		expect((res.details as { outcome: string }).outcome).toBe("success");
		expect(res.content[0]?.text).toContain("function greet");
	});

	test("ast replace previews without writing, applies on request", async () => {
		const dir = fixture();
		const tool = capture(dir).get("replace");
		if (!tool) throw new Error("tool missing");
		const preview = await tool.execute("t", {
			pattern: "greet($A)",
			rewrite: "welcome($A)",
			paths: ["a.ts"],
		});
		expect((preview.details as { applied: boolean; edits: number }).applied).toBe(false);
		expect((preview.details as { edits: number }).edits).toBe(2);
		// File is unchanged after a preview.
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toContain("greet('a')");

		const applied = await tool.execute("t", {
			pattern: "greet($A)",
			rewrite: "welcome($A)",
			paths: ["a.ts"],
			apply: true,
		});
		expect((applied.details as { applied: boolean }).applied).toBe(true);
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toContain("welcome('a')");
	});

	test("ast replace keeps captured `$NAME` text and diffs line-count changes correctly", async () => {
		const dir = mkdtempSync(join(tempDir(), "pix-astgrep-rewrite-"));
		writeFileSync(join(dir, "b.ts"), "log('$B');\nconst tail = 1;\n");
		const tool = capture(dir).get("replace");
		if (!tool) throw new Error("tool missing");
		const res = await tool.execute("t", {
			pattern: "log($A)",
			rewrite: "debug($A);\nlog($A)",
			paths: ["b.ts"],
			apply: true,
		});
		// The capture `'$B'` is inserted verbatim, not re-substituted as a metavariable.
		expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe(
			"debug('$B');\nlog('$B');\nconst tail = 1;\n",
		);
		// One inserted line: the unchanged tail is context, not a delete/add pair.
		const text = res.content[0]?.text ?? "";
		expect(text).toMatch(/^--- b\.ts\n\+\+\+ b\.ts\n\+1: debug\('\$B'\);\n 2: log\('\$B'\);$/m);
		expect(text).not.toContain("const tail");
	});

	test("ast search finds every call of a pattern", async () => {
		const dir = fixture();
		const tool = capture(dir).get("search");
		if (!tool) throw new Error("tool missing");
		const res = await tool.execute("t", { pattern: "greet($A)", paths: ["."] });
		expect((res.details as { matches: number }).matches).toBe(2);
		expect(res.content[0]?.text).toContain("a.ts:");
	});

	test("search, replace and outline discover Python files and reach grammar consent", async () => {
		const dir = mkdtempSync(join(tempDir(), "pix-astgrep-python-"));
		writeFileSync(join(dir, "case_body.py"), "import math\n");
		const tools = capture(dir);
		let prompts = 0;
		const ctx = {
			hasUI: true,
			ui: {
				custom: async () => {
					prompts++;
					return { action: "denied" };
				},
			},
		};
		for (const name of ["search", "replace", "outline"]) {
			const tool = tools.get(name);
			if (!tool) throw new Error("tool missing");
			const res = await tool.execute(
				"t",
				{
					pattern: "import $M",
					rewrite: "import $M",
					paths: [name === "search" ? "." : "case_body.py"],
					lang: "python",
					path: "case_body.py",
				},
				undefined,
				undefined,
				ctx as ExecuteCtx,
			);
			expect(res.isError).toBe(true);
			expect(res.content[0]?.text).toMatch(/python.*@ast-grep\/lang-python/);
		}
		expect(prompts).toBe(1);
		const outline = tools.get("outline");
		if (!outline) throw new Error("tool missing");
		const result = await outline.execute("t", { path: "." });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/python.*@ast-grep\/lang-python/);
	});

	test("a missing grammar does not apply earlier replacements", async () => {
		const dir = fixture();
		writeFileSync(join(dir, "z.py"), "import math\n");
		const tool = capture(dir).get("replace");
		if (!tool) throw new Error("tool missing");
		const before = readFileSync(join(dir, "a.ts"), "utf8");
		const res = await tool.execute("t", {
			pattern: "greet($A)",
			rewrite: "welcome($A)",
			paths: ["a.ts", "z.py"],
			apply: true,
		});
		expect(res.isError).toBe(true);
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe(before);
	});

	test("ast symbol returns one symbol body with a header line", async () => {
		const dir = fixture();
		const tool = capture(dir).get("symbol");
		if (!tool) throw new Error("tool missing");
		const res = await tool.execute("t", { path: "a.ts", symbol: "greet" });
		expect((res.details as { outcome: string }).outcome).toBe("success");
		expect(res.content[0]?.text).toContain("function greet");
		expect(res.content[0]?.text).toContain("a.ts:1");
	});

	test("ast symbol reports a missing symbol as an error", async () => {
		const dir = fixture();
		const tool = capture(dir).get("symbol");
		if (!tool) throw new Error("tool missing");
		const res = await tool.execute("t", { path: "a.ts", symbol: "nope" });
		expect(res.isError).toBe(true);
		expect(res.content[0]?.text).toContain("not found");
	});

	test("ast symbols ranks files by identifier and returns the match count", async () => {
		const dir = fixture();
		const tool = capture(dir).get("symbols");
		if (!tool) throw new Error("tool missing");
		const res = await tool.execute("t", { query: "greet" });
		const details = res.details as { count: number };
		expect(details.count).toBeGreaterThanOrEqual(1);
		expect(res.content[0]?.text).toContain("a.ts");
	});

	test("ast symbols AND-matches every term", async () => {
		const dir = fixture();
		const tool = capture(dir).get("symbols");
		if (!tool) throw new Error("tool missing");
		const res = await tool.execute("t", { query: "greet Widget" });
		// No single file contains both identifiers.
		expect((res.details as { count: number }).count).toBe(0);
	});
});

test("all AST tools reject cancelled calls before parsing or writing", async () => {
	const dir = fixture();
	const before = readFileSync(join(dir, "a.ts"), "utf8");
	for (const tool of capture(dir).values()) {
		await expect(
			tool.execute(
				"cancel",
				{
					path: "a.ts",
					paths: ["."],
					query: "greet",
					pattern: "greet($A)",
					rewrite: "changed($A)",
					apply: true,
				},
				AbortSignal.abort(),
			),
		).rejects.toThrow();
	}
	expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe(before);
});

test("AST replacement yields to Esc before the write phase", async () => {
	const dir = fixture();
	const before = readFileSync(join(dir, "a.ts"), "utf8");
	const controller = new AbortController();
	const tool = capture(dir).get("replace")!;
	const pending = tool.execute(
		"cancel",
		{ paths: ["."], pattern: "greet($A)", rewrite: "changed($A)", apply: true },
		controller.signal,
	);
	setImmediate(() => controller.abort());
	await expect(pending).rejects.toThrow();
	expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe(before);
});
