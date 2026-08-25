import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerGraph from "./graph.js";

type ExecuteFn = (
	id: string,
	params: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; isError?: boolean; details?: unknown }>;

/** Minimal ExtensionAPI mock that captures the registered tool's execute fn. */
function capture(): ExecuteFn {
	let execute: ExecuteFn | null = null;
	const pi = {
		registerTool(def: { execute: ExecuteFn }) {
			execute = def.execute;
		},
	} as never;
	registerGraph(pi);
	if (!execute) throw new Error("graph tool not registered");
	return execute;
}

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "pix-graph-tool-"));
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
async function run(params: Record<string, unknown>, cwd: string) {
	const prev = process.cwd();
	process.chdir(cwd);
	try {
		return await capture()("t", params);
	} finally {
		process.chdir(prev);
	}
}

describe("graph tool", () => {
	test("build mode writes the graph and reports counts", async () => {
		const root = fixture();
		const res = await run({ mode: "build" }, root);
		expect(res.isError).toBeFalsy();
		const text = res.content.map((c) => c.text).join("");
		expect(text).toContain("Graph built");
		expect(text).toContain(".pi/pix-graph");
	});

	test("query mode traverses a built graph", async () => {
		const root = fixture();
		await run({ mode: "build" }, root);
		const res = await run({ mode: "query", question: "greet util" }, root);
		expect(res.isError).toBeFalsy();
		expect(res.content.map((c) => c.text).join("")).toContain("greet");
	});

	test("query without a graph errors with guidance", async () => {
		const root = fixture();
		const res = await run({ mode: "query", question: "anything" }, root);
		expect(res.isError).toBe(true);
		expect(res.content.map((c) => c.text).join("")).toContain("build");
	});

	test("query without a question errors", async () => {
		const root = fixture();
		const res = await run({ mode: "query" }, root);
		expect(res.isError).toBe(true);
	});

	test("query returns structured hits for the tree render", async () => {
		const root = fixture();
		await run({ mode: "build" }, root);
		const res = await run({ mode: "query", question: "greet util" }, root);
		const q = (res.details as { query?: { question: string; traversal: string; hits: unknown[] } })
			.query;
		expect(q?.traversal).toBe("bfs");
		expect(q?.question).toBe("greet util");
		expect(Array.isArray(q?.hits)).toBe(true);
		expect(q?.hits.length ?? 0).toBeGreaterThan(0);
	});

	test("stop-words don't drown real seeds (recall)", async () => {
		const root = fixture();
		await run({ mode: "build" }, root);
		// "how does" is filler; "greet" must still seed the greet node.
		const res = await run({ mode: "query", question: "how does greet work" }, root);
		const hits = (res.details as { query?: { hits: Array<{ label: string }> } }).query?.hits ?? [];
		expect(hits.some((h) => h.label.includes("greet"))).toBe(true);
	});
});
