import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { godNodes, surprisingConnections } from "./analyze.js";
import { buildGraph } from "./build.js";
import { cluster, cohesionScore } from "./cluster.js";
import { collectFiles, extract } from "./extract.js";
import { buildCodeGraph } from "./pipeline.js";
import { query, shortestPath } from "./query.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Two packages, a cross-file call, and an isolated helper. */
function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "pix-graph-"));
	dirs.push(root);
	mkdirSync(join(root, "packages/a/src"), { recursive: true });
	mkdirSync(join(root, "packages/b/src"), { recursive: true });
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

describe("extract", () => {
	test("emits file + entity nodes and a cross-file call edge", () => {
		const root = fixture();
		const { nodes, links } = extract(collectFiles(root), root);
		const ids = new Set(nodes.map((n) => n.id));
		expect(ids.has("src_util_greet")).toBe(true);
		expect(ids.has("src_main_run")).toBe(true);

		const call = links.find((l) => l.relation === "calls" && l.target === "src_util_greet");
		expect(call).toBeDefined();
		expect(call?.confidence).toBe("INFERRED");
		expect(call?.source_file).toBe("packages/a/src/main.ts");

		// contains + imports are EXTRACTED
		expect(links.some((l) => l.relation === "contains")).toBe(true);
		expect(links.some((l) => l.relation === "imports")).toBe(true);
	});

	test("skips node_modules and non-code files", () => {
		const root = fixture();
		mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
		writeFileSync(join(root, "node_modules/pkg/index.ts"), "export const x = 1;\n");
		writeFileSync(join(root, "packages/a/README.md"), "# docs\n");
		const files = collectFiles(root);
		expect(files.every((f) => !f.includes("node_modules"))).toBe(true);
		expect(files.every((f) => f.endsWith(".ts"))).toBe(true);
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
		expect(surprises.some((s) => s.target === "src_util_greet")).toBe(true);
	});
});

describe("query", () => {
	test("bfs finds seed nodes and neighbors; path connects them", () => {
		const root = fixture();
		const { graph } = buildGraph(extract(collectFiles(root), root));
		const hits = query(graph, "greet util", { maxDepth: 2 });
		expect(hits.some((h) => h.node.id === "src_util_greet")).toBe(true);

		const path = shortestPath(graph, "run()", "greet()");
		expect(path.length).toBeGreaterThanOrEqual(2);
		expect(path.at(-1)?.id).toBe("src_util_greet");
	});
});

describe("buildCodeGraph", () => {
	test("writes graph.json, cleaned graph, and report", () => {
		const root = fixture();
		const out = join(root, "graphify-out");
		const result = buildCodeGraph(root, root, out);
		expect(result.nodes).toBeGreaterThan(0);
		expect(existsSync(join(out, "graph.json"))).toBe(true);
		expect(existsSync(join(out, "graph.cleaned.json"))).toBe(true);
		expect(existsSync(join(out, "GRAPH_REPORT.md"))).toBe(true);

		const graph = JSON.parse(readFileSync(join(out, "graph.json"), "utf8"));
		expect(Array.isArray(graph.nodes)).toBe(true);
		// cleaned graph drops the false cross-package call (greet is a real import → kept)
		const cleaned = JSON.parse(readFileSync(join(out, "graph.cleaned.json"), "utf8"));
		expect(cleaned.nodes.length).toBe(graph.nodes.length);
	});
});
