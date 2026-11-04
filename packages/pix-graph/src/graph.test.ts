import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@xynogen/pix-runtime/paths";
import registerGraph, { impactRows } from "./graph.ts";

type ExecuteFn = (
	id: string,
	params: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; isError?: boolean; details?: unknown }>;

type ToolDef = {
	renderShell?: string;
	renderCall: (
		args: { action: string; question?: string },
		theme: { fg: (role: string, text: string) => string; bold: (text: string) => string },
		context: { state: { collapsed: boolean }; expanded: boolean },
	) => { render: (width: number) => string[] };
	execute: ExecuteFn;
	renderResult: (
		result: { content: Array<{ type: "text"; text: string }>; details?: unknown },
		options: { expanded: boolean; isPartial: boolean },
		theme: { fg: (role: string, text: string) => string; bold: (text: string) => string },
		context: {
			isError: boolean;
			state?: { collapsed: boolean };
			expanded?: boolean;
			invalidate?: () => void;
		},
	) => { render: (width: number) => string[] };
};

type CommandDef = {
	handler: (
		args: string,
		ctx: { ui: { notify(msg: string, kind?: string): void } },
	) => Promise<void>;
};
let command: CommandDef | null = null;

/** Minimal ExtensionAPI mock that captures the registered tool and command. */
function captureTool(): ToolDef {
	let tool: ToolDef | null = null;
	const pi = {
		registerTool(def: ToolDef) {
			tool = def;
		},
		registerCommand(name: string, def: CommandDef) {
			if (name === "graph") command = def;
		},
	} as never;
	registerGraph(pi);
	if (!tool) throw new Error("graph tool not registered");
	return tool;
}

function capture(): ExecuteFn {
	return captureTool().execute;
}

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(): string {
	const root = mkdtempSync(join(tempDir(), "pix-graph-tool-"));
	dirs.push(root);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src/util.ts"), "export function greet() {\n\treturn 1;\n}\n");
	writeFileSync(
		join(root, "src/main.ts"),
		[
			`import { greet } from ${'"./util"'};`,
			"export function run() {",
			"\treturn greet();",
			"}",
		].join("\n"),
	);
	return root;
}

/** Register + execute with cwd pointed at the fixture (the tool binds cwd at
 * registration time, so chdir must happen before capture). */
async function run(params: Record<string, unknown>, cwd: string, ctx?: unknown) {
	const prev = process.cwd();
	process.chdir(cwd);
	try {
		return await (capture() as (...a: unknown[]) => ReturnType<ExecuteFn>)(
			"t",
			params,
			undefined,
			undefined,
			ctx,
		);
	} finally {
		process.chdir(prev);
	}
}

describe("graph tool", () => {
	test("uses a self-rendered single row after collapse and keeps the full result on expand", () => {
		const tool = captureTool();
		const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
		const state = { collapsed: true };
		const context = { state, expanded: false, isError: false, invalidate: () => {} };
		const result = {
			content: [{ type: "text" as const, text: "answer" }],
			details: { _type: "graphResult", action: "query", outcome: "success" },
		};
		expect(tool.renderShell).toBe("self");
		expect(
			tool
				.renderCall({ action: "query", question: "how" }, theme, context)
				.render(80)
				.join("\n")
				.trim(),
		).toBe("");
		const collapsed = tool
			.renderResult(result, { expanded: false, isPartial: false }, theme, context)
			.render(80)
			.join("\n");
		expect(collapsed).toMatch(/graph.*query/);
		expect(collapsed.split("\n")).toHaveLength(1);
		const expanded = tool
			.renderResult(result, { expanded: true, isPartial: false }, theme, {
				...context,
				expanded: true,
			})
			.render(80)
			.join("\n");
		expect(expanded).toContain("answer");
		expect(expanded.split("\n").length).toBeGreaterThan(1);
	});

	test("frames terminal results by status but leaves running and partial results open", () => {
		const renderResult = captureTool().renderResult;
		const theme = {
			fg: (role: string, text: string) => `[${role}]${text}[/${role}]`,
			bold: (text: string) => text,
		};
		const render = (
			outcome: "success" | "error" | "running" | undefined,
			isPartial = false,
			expanded = false,
		): string =>
			renderResult(
				{
					content: [{ type: "text", text: "result" }],
					...(outcome ? { details: { _type: "graphResult", action: "build", outcome } } : {}),
				},
				{ expanded, isPartial },
				theme,
				{
					isError: outcome === "error",
					state: { collapsed: false },
					expanded,
					invalidate: () => {},
				},
			)
				.render(20)
				.join("\n");

		expect(render("success")).toContain("[success]────────────────────[/success]");
		expect(render("success")).not.toContain("└─");
		expect(render("error")).toContain("[error]────────────────────[/error]");
		expect(render("success", false, true)).toContain("[success]────────────────────[/success]");
		expect(render("running")).not.toContain("───");
		expect(render("success", true)).not.toContain("───");
		expect(render(undefined)).toContain("[success]────────────────────[/success]");
	});

	test("build mode writes the graph and reports counts", async () => {
		const root = fixture();
		const res = await run({ action: "build" }, root);
		expect(res.isError).toBeFalsy();
		const text = res.content.map((c) => c.text).join("");
		expect(text).toContain("Graph built");
		expect(text).toContain(".pi/graph/");
	});

	test("a repeated build reports a cache hit", async () => {
		const root = fixture();
		await run({ action: "build" }, root);
		const result = await run({ action: "build" }, root);
		expect(result.content[0]?.text).toMatch(/Graph unchanged \(cache hit\).*files.*nodes/);
	});

	test("query mode traverses a built graph", async () => {
		const root = fixture();
		await run({ action: "build" }, root);
		const res = await run({ action: "query", question: "greet util" }, root);
		expect(res.isError).toBeFalsy();
		expect(res.content.map((c) => c.text).join("")).toContain("greet");
	});

	test("query without a graph errors with guidance", async () => {
		const root = fixture();
		const res = await run({ action: "query", question: "anything" }, root);
		expect(res.isError).toBe(true);
		expect(res.content.map((c) => c.text).join("")).toContain("build");
	});

	test("query without a question errors", async () => {
		const root = fixture();
		const res = await run({ action: "query" }, root);
		expect(res.isError).toBe(true);
	});

	test("impact lists callers of a symbol and errors on an unknown name", async () => {
		const root = fixture();
		await run({ action: "build" }, root);
		const res = await run({ action: "impact", question: "greet" }, root);
		const text = res.content.map((c) => c.text).join("");
		expect(res.isError).toBeFalsy();
		expect(text).toMatch(/greet\(\)[\s\S]*run\(\) \(via called by\) — src\/main\.ts/);
		expect(text).toMatch(/^\d+ dependent\(s\) in \d+ file\(s\)\.$/m);
		const miss = await run({ action: "impact", question: "nope" }, root);
		expect(miss.isError).toBe(true);
	});

	test("impact on a name with more than 5 nodes asks for path instead of walking", async () => {
		const root = fixture();
		for (let i = 0; i < 6; i++) {
			writeFileSync(join(root, `src/dup${i}.ts`), "export function dup() {\n\treturn 1;\n}\n");
		}
		await run({ action: "build" }, root);
		const res = await run({ action: "impact", question: "dup" }, root);
		const text = res.content.map((c) => c.text).join("");
		expect(res.isError).toBe(true);
		expect(text).toMatch(
			/^"dup" matches 6 nodes\. Pass path[^\n]*\n( {2}src\/dup\d\.ts \(dup\(\)\)\n){5} {2}… \+1 more$/,
		);
		const one = await run({ action: "impact", question: "dup", path: "dup3" }, root);
		expect(one.isError).toBeFalsy();
	});

	test("query and impact rebuild a stale graph first and say so", async () => {
		const root = fixture();
		await run({ action: "build" }, root);
		const fresh = await run({ action: "impact", question: "greet" }, root);
		expect(fresh.content[0]?.text).toMatch(/Tests: none reach it\.$/);
		// A new caller lands after the build. Backdating the outputs keeps the test independent
		// of filesystem mtime resolution.
		writeFileSync(
			join(root, "src/main.ts"),
			'import { greet } from "./util";\nexport function run() { return greet(); }\nexport function late() { return greet(); }\n',
		);
		const earlier = new Date(Date.now() - 60_000);
		for (const name of ["graph.json", "graph.cleaned.json"]) {
			utimesSync(join(root, ".pi/graph", name), earlier, earlier);
		}
		const res = await run({ action: "impact", question: "greet" }, root);
		const text = res.content[0]?.text ?? "";
		expect(text).toMatch(/late\(\) \(via called by\)/);
		expect(text).toMatch(
			/\n\nGraph rebuilt first: \d+ file\(s\) changed since the last build \([^)]+\)\.$/,
		);
		const again = await run({ action: "query", question: "greet" }, root);
		expect(again.content[0]?.text).not.toMatch(/Graph rebuilt first/);
	});

	test("impact folds indirect dependents by file above the tree limit", () => {
		const row = (label: string, depth: number, where: string) => ({ label, depth, where });
		const rows = [
			row("seed()", 0, "a.ts"),
			...Array.from({ length: 5 }, (_, i) => row(`d1_${i}()`, 1, `b${i}.ts`)),
			...Array.from({ length: 24 }, (_, i) => row(`d2_${i}()`, 2, `c${i % 3}.ts`)),
		];
		const { rows: shown, folded, foldedBy } = impactRows(rows);
		expect(shown.map((r) => r.depth)).toEqual([0, 1, 1, 1, 1, 1]);
		expect(folded).toEqual(["  c0.ts (8)", "  c1.ts (8)", "  c2.ts (8)"]);
		expect(foldedBy).toBe("file");
		expect(impactRows(rows.slice(0, 20)).folded).toEqual([]);

		// Too many direct dependents: everything but the seed folds per package.
		const wide = [
			row("seed()", 0, "packages/a/src/x.ts"),
			...Array.from({ length: 30 }, (_, i) =>
				row(`d${i}()`, 1, i < 20 ? `packages/b/src/f${i}.ts` : `scripts/s${i}.ts`),
			),
			row("deep()", 2, "packages/b/src/deep.ts"),
		];
		const out = impactRows(wide);
		expect(out.rows.map((r) => r.depth)).toEqual([0]);
		expect(out.folded).toEqual(["  packages/b (21)", "  scripts (10)"]);
		expect(out.foldedBy).toBe("package");
	});

	test("query returns structured hits for the tree render", async () => {
		const root = fixture();
		await run({ action: "build" }, root);
		const res = await run({ action: "query", question: "greet util" }, root);
		const q = (res.details as { query?: { question: string; traversal: string; hits: unknown[] } })
			.query;
		expect(q?.traversal).toBe("bfs");
		expect(q?.question).toBe("greet util");
		expect(Array.isArray(q?.hits)).toBe(true);
		expect(q?.hits.length ?? 0).toBeGreaterThan(0);
	});

	test("stop-words don't drown real seeds (recall)", async () => {
		const root = fixture();
		await run({ action: "build" }, root);
		// "how does" is filler; "greet" must still seed the greet node.
		const res = await run({ action: "query", question: "how does greet work" }, root);
		const hits = (res.details as { query?: { hits: Array<{ label: string }> } }).query?.hits ?? [];
		expect(hits.some((h) => h.label.includes("greet"))).toBe(true);
	});

	test("summarize lists stale modules, stores grounded summaries, then has no work left", async () => {
		const root = fixture();
		await run({ action: "build" }, root);
		const text = async (p: Record<string, unknown>, ctx?: unknown) =>
			(await run(p, root, ctx)).content.map((c) => c.text).join("");

		const list = await text({ action: "summarize" });
		expect(list).toMatch(
			/^1 of 1 module summaries missing or stale\. Showing 1 evidence card\(s\), ~\d+ tokens\./,
		);
		expect(list).toContain("module src — 2 files (+0 tests), 2 symbols");
		expect(list).toContain("entry files: src/main.ts");

		const rejected = await run(
			{ action: "summarize", module: "src", summary: "Does things." },
			root,
		);
		expect(rejected.isError).toBe(true);
		expect(rejected.content[0]?.text).toMatch(/^Summary rejected: summary cites nothing/);

		const model = { model: { provider: "p", id: "m" } };
		const stored = await text(
			{ action: "summarize", module: "src", summary: "src greets: main.ts calls greet()." },
			model,
		);
		expect(stored).toMatch(
			/^Stored summary for src \(model p\/m, evidence [0-9a-f]{16}\).* 0 module\(s\) still/,
		);

		// Unchanged rerun: zero modules to summarize, so zero model work.
		await run({ action: "build" }, root);
		expect(await text({ action: "summarize" })).toBe(
			"All 1 module summaries are current. Nothing to write.",
		);

		const global = await text({ action: "query", scope: "global", question: "who greets" });
		expect(global).toMatch(/^summary \[p\/m\]: src greets: main\.ts calls greet\(\)\.\nmodule src/);

		// A source change moves the evidence hash: the summary turns stale and is listed again.
		writeFileSync(join(root, "src/extra.ts"), "export const extra = 1;\n");
		await run({ action: "build" }, root);
		expect(await text({ action: "summarize" })).toMatch(
			/^1 of 1 module summaries missing or stale/,
		);
	});

	test("/graph warns when no graph exists", async () => {
		const root = fixture();
		const prev = process.cwd();
		process.chdir(root);
		const notes: Array<[string, string | undefined]> = [];
		try {
			captureTool();
			await command?.handler("", { ui: { notify: (msg, kind) => notes.push([msg, kind]) } });
		} finally {
			process.chdir(prev);
		}
		expect(notes).toEqual([
			['No graph yet. Ask the agent to run graph(action:"build").', "warning"],
		]);
	});
});
