import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { godNodes, surprisingConnections } from "./analyze.ts";
import { buildGraph } from "./build.ts";
import { cluster, cohesionScore } from "./cluster.ts";
import { collectFiles, extract } from "./extract.ts";
import { buildCodeGraph, buildCodeGraphProgress, createGraphParseCache } from "./pipeline.ts";
import { query, shortestPath } from "./query.ts";
import { boundaries, renderGraphReport } from "./report.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Two packages, a cross-file call, and an isolated helper. */
function fixture(): string {
	const root = mkdtempSync(join(tempDir(), "pix-graph-"));
	dirs.push(root);
	mkdirSync(join(root, "packages/a/src"), { recursive: true });
	mkdirSync(join(root, "packages/b/src"), { recursive: true });
	writeFileSync(join(root, "packages/a/package.json"), '{"name":"@xynogen/a"}');
	writeFileSync(
		join(root, "packages/b/package.json"),
		'{"name":"@xynogen/b","exports":{"./util":"./src/util.ts"}}',
	);
	writeFileSync(
		join(root, "packages/b/src/util.ts"),
		'export function greet(name: string) {\n\treturn "hi " + name;\n}\n',
	);
	writeFileSync(
		join(root, "packages/a/src/main.ts"),
		[
			`import { greet } from ${'"@xynogen/b/util"'};`,
			"export function run() {",
			'\treturn greet("world");',
			"}",
			"export function unused() {",
			"\treturn 1;",
			"}",
		].join("\n"),
	);
	writeFileSync(join(root, "packages/a/src/lonely.ts"), "export const lonely = 42;\n");
	return root;
}

const GREET = "packages_b_src_util_ts_greet";

describe("extract", () => {
	test("emits file + entity nodes and a resolved cross-package call edge", () => {
		const root = fixture();
		const { nodes, links } = extract(collectFiles(root), root);
		const ids = new Set(nodes.map((n) => n.id));
		expect(ids.has(GREET)).toBe(true);
		expect(ids.has("packages_a_src_main_ts_run")).toBe(true);

		const call = links.find((l) => l.relation === "calls" && l.target === GREET);
		expect(call).toMatchObject({
			source: "packages_a_src_main_ts_run",
			confidence: "EXTRACTED",
			source_file: "packages/a/src/main.ts",
			source_location: "L3",
		});
		expect(links.find((l) => l.relation === "imports")).toMatchObject({
			source: "packages_a_src_main_ts",
			target: "packages_b_src_util_ts",
			source_location: "L1",
		});
		expect(nodes.find((n) => n.id === GREET)?.package).toBe("@xynogen/b");
	});

	test("distinct file ids, re-exports, namespace calls, and unresolved internal imports", () => {
		const root = mkdtempSync(join(tempDir(), "pix-graph-"));
		dirs.push(root);
		const put = (rel: string, body: string) => {
			mkdirSync(join(root, rel, ".."), { recursive: true });
			writeFileSync(join(root, rel), body);
		};
		put("packages/a/package.json", '{"name":"@x/a","exports":{".":"./src/index.ts"}}');
		put("packages/b/package.json", '{"name":"@x/b","exports":{".":"./src/index.ts"}}');
		put("packages/a/src/core.ts", "export function render() {}\nexport function it() {}\n");
		put(
			"packages/a/src/index.ts",
			// `.js` spelled apart: the repo guard bans real `.js` relative imports, this one is test data.
			`export { render as draw } from "./core${".js"}";\nexport * from "./core.ts";\n`,
		);
		put(
			"packages/b/src/index.ts",
			[
				'import { draw } from "@x/a";',
				'import * as a from "@x/a";',
				'import { gone } from "./missing";',
				"function it() {}",
				"export function main() { draw(); a.it(); it(); gone(); }",
			].join("\n"),
		);
		put("packages/b/src/other.ts", "export function render() {}\n");
		const { nodes, links, unresolved } = extract(collectFiles(root), root);

		const files = nodes.filter((n) => !n.source_location).map((n) => n.id);
		expect(new Set(files).size).toBe(4);
		expect(files).toContain("packages_a_src_index_ts");
		expect(files).toContain("packages_b_src_index_ts");

		const calls = links
			.filter((l) => l.relation === "calls")
			.map((l) => `${l.source} -> ${l.target}`)
			.sort();
		// `draw` follows the aliased re-export; `a.it` the star re-export. Local `it()` and the
		// same-named `render` in b/other.ts never link across packages.
		expect(calls).toEqual([
			"packages_b_src_index_ts_main -> packages_a_src_core_ts_it",
			"packages_b_src_index_ts_main -> packages_a_src_core_ts_render",
		]);
		expect(unresolved).toEqual([
			{ source_file: "packages/b/src/index.ts", source_location: "L3", specifier: "./missing" },
		]);
	});

	test("respects ignore files and scans un-ignored hidden dirs", () => {
		const root = fixture();
		const put = (rel: string, body = "export const x = 1;\n") => {
			mkdirSync(join(root, rel, ".."), { recursive: true });
			writeFileSync(join(root, rel), body);
		};
		put(".gitignore", "node_modules\n.venv\n");
		put(".dockerignore", "dist\n");
		put("node_modules/pkg/index.ts");
		put(".venv/lib/site-packages/x.js");
		put("dist/out.js");
		put(".pi/ext/hook.ts");
		put("packages/a/README.md", "# docs\n");
		const rel = collectFiles(root).map((f) => f.slice(root.length + 1).replaceAll("\\", "/"));
		expect(rel).toEqual([
			".pi/ext/hook.ts",
			"packages/a/src/lonely.ts",
			"packages/a/src/main.ts",
			"packages/b/src/util.ts",
		]);
	});

	test("ignores the user's ripgrep config", () => {
		const root = fixture();
		const config = join(root, "rgrc");
		writeFileSync(config, "--glob=!packages/b/**\n");
		const previous = process.env.RIPGREP_CONFIG_PATH;
		process.env.RIPGREP_CONFIG_PATH = config;
		try {
			const rel = collectFiles(root).map((f) => f.slice(root.length + 1).replaceAll("\\", "/"));
			expect(rel).toContain("packages/b/src/util.ts");
		} finally {
			if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
			else process.env.RIPGREP_CONFIG_PATH = previous;
		}
	});
});

describe("cluster", () => {
	test("assigns communities and scores cohesion", () => {
		const root = fixture();
		const { graph, communities, cohesion } = buildGraph(extract(collectFiles(root), root));
		expect(communities.size).toBeGreaterThan(0);
		// every node lands in exactly one community
		const assigned = new Set<string>();
		for (const members of communities.values()) for (const m of members) assigned.add(m);
		expect(assigned.size).toBe(graph.nodes.length);
		for (const score of cohesion.values()) {
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(1);
		}
	});

	test("cohesion of a fully connected triple is 1", () => {
		const graph = {
			nodes: [
				{ id: "a", label: "a" },
				{ id: "b", label: "b" },
				{ id: "c", label: "c" },
			],
			links: [
				{ source: "a", target: "b", relation: "x" },
				{ source: "b", target: "c", relation: "x" },
				{ source: "a", target: "c", relation: "x" },
			],
		};
		expect(cohesionScore(graph, ["a", "b", "c"])).toBe(1);
	});

	test("cohesion counts parallel and reverse edges once", () => {
		const graph = {
			nodes: [
				{ id: "a", label: "a" },
				{ id: "b", label: "b" },
				{ id: "c", label: "c" },
			],
			links: [
				{ source: "a", target: "b", relation: "calls" },
				{ source: "a", target: "b", relation: "imports" },
				{ source: "b", target: "a", relation: "calls" },
				{ source: "b", target: "c", relation: "x" },
			],
		};
		expect(cohesionScore(graph, ["a", "b", "c", "a"])).toBe(0.67);
	});

	test("ownership never glues communities; labels and boundaries are deterministic", () => {
		const root = fixture();
		const built = buildGraph(extract(collectFiles(root), root));
		const of = (id: string) => built.graph.nodes.find((n) => n.id === id)?.community;
		// Entities share their file's community; the isolated file stays alone.
		expect(of("packages_a_src_main_ts_unused")).toBe(of("packages_a_src_main_ts"));
		expect(of(GREET)).toBe(of("packages_a_src_main_ts"));
		expect(of("packages_a_src_lonely_ts")).not.toBe(of("packages_a_src_main_ts"));
		const main = of("packages_a_src_main_ts") as number;
		expect(built.labels.get(main)).toMatch(/^@xynogen\/[ab] · (run|greet)\(\)$/);

		const report = renderGraphReport({ ...built, gods: [], surprises: [] });
		expect(report).toContain(
			"- `@xynogen/a` → `@xynogen/b`: 1 imports, 1 calls — uses `greet()`\n  - at packages/a/src/main.ts:L1",
		);
		expect(boundaries(built.graph)).toHaveLength(1);
	});

	test("empty graph yields no communities", () => {
		expect(cluster({ nodes: [], links: [] }).size).toBe(0);
	});
});

describe("analyze", () => {
	test("god nodes exclude file hubs, surprises flag cross-package calls", () => {
		const root = fixture();
		const { graph, communities } = buildGraph(extract(collectFiles(root), root));
		const gods = godNodes(graph);
		expect(gods.every((g) => !g.label.endsWith(".ts"))).toBe(true);

		const surprises = surprisingConnections(graph, communities);
		expect(surprises.some((s) => s.target === GREET)).toBe(true);
	});
});

describe("query", () => {
	test("bfs finds seed nodes and neighbors; path connects them", () => {
		const root = fixture();
		const { graph } = buildGraph(extract(collectFiles(root), root));
		const hits = query(graph, "greet util", { maxDepth: 2 });
		expect(hits.some((h) => h.node.id === GREET)).toBe(true);

		const path = shortestPath(graph, "run()", "greet()");
		expect(path.length).toBeGreaterThanOrEqual(2);
		expect(path.at(-1)?.id).toBe(GREET);
	});
});

describe("buildCodeGraph", () => {
	test("reuses unchanged output and rebuilds after a same-size edit or missing output", async () => {
		const root = fixture();
		const out = join(root, ".pi/graph");
		const input = join(root, "packages/a/src/lonely.ts");
		const progress = () => {};
		const first = await buildCodeGraphProgress(root, root, out, progress);
		expect(first.cached).toBe(false);
		const second = await buildCodeGraphProgress(root, root, out, progress);
		expect(second.cached).toBe(true);
		expect(second.nodes).toBe(first.nodes);
		const before = statSync(input);
		writeFileSync(input, "export const lonely = 43;\n");
		utimesSync(input, before.atime, before.mtime);
		expect((await buildCodeGraphProgress(root, root, out, progress)).cached).toBe(false);
		expect((await buildCodeGraphProgress(root, root, out, progress)).cached).toBe(true);
		unlinkSync(join(out, "graph.cleaned.json"));
		expect((await buildCodeGraphProgress(root, root, out, progress)).cached).toBe(false);
	});

	test("reuses parsed source files on a changed build", async () => {
		const root = fixture();
		const out = join(root, ".pi/graph");
		const cache = createGraphParseCache();
		const progress = () => {};
		await buildCodeGraphProgress(root, root, out, progress, undefined, cache);
		const input = join(root, "packages/a/src/lonely.ts");
		writeFileSync(input, "export const lonely = 43;\n");
		const result = await buildCodeGraphProgress(root, root, out, progress, undefined, cache);
		expect(result.cached).toBe(false);
		expect(result.parsedFiles).toBe(1);
		expect(result.reusedFiles).toBe(2);
		const graph = JSON.parse(readFileSync(join(out, "graph.json"), "utf8"));
		expect(graph.nodes.some((node: { label: string }) => node.label === "lonely")).toBe(true);
	});

	test("writes graph.json, cleaned graph, and report", () => {
		const root = fixture();
		const out = join(root, "graphify-out");
		const result = buildCodeGraph(root, root, out);
		expect(result.nodes).toBeGreaterThan(0);
		expect(existsSync(join(out, "graph.json"))).toBe(true);
		expect(existsSync(join(out, "graph.cleaned.json"))).toBe(true);
		expect(existsSync(join(out, "GRAPH_REPORT.md"))).toBe(true);
		expect(readFileSync(join(out, "graph.html"), "utf8")).toMatch(/d3\.forceSimulation\(/);

		const graph = JSON.parse(readFileSync(join(out, "graph.json"), "utf8"));
		expect(Array.isArray(graph.nodes)).toBe(true);
		// cleaned graph drops the false cross-package call (greet is a real import → kept)
		const cleaned = JSON.parse(readFileSync(join(out, "graph.cleaned.json"), "utf8"));
		expect(cleaned.nodes.length).toBe(graph.nodes.length);
	});
});
