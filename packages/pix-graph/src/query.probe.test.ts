import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { analyzeGraph } from "./analyzer.ts";
import { buildGraph } from "./build.ts";
import { collectFiles, extract } from "./extract.ts";
import { query } from "./query.ts";

// Recall probe on this repo's own source (plan: .pi/plans/pix-graph-hierarchical.md, phase 0).
// ponytail: tied to real file names; update a row when a probed file is renamed.
const root = resolve(import.meta.dir, "../../..");
const files = ["packages/pix-graph/src", "packages/pix-runtime/src"].flatMap((d) =>
	collectFiles(resolve(root, d)),
);
const built = buildGraph(extract(files, root));
const graph = analyzeGraph(built.graph, { repoRoot: root }).cleanedGraph;
const byId = new Map(graph.nodes.map((n) => [n.id, n]));

test.each([
	["how are communities detected", "pix-graph/src/cluster.ts"],
	["where is the interactive html page rendered", "pix-graph/src/html.ts"],
	["how does the build cache decide to reuse output", "pix-graph/src/pipeline.ts"],
	["which files are scanned and which are ignored", "pix-graph/src/extract.ts"],
	["how is an external binary resolved and downloaded", "pix-runtime/src/binaries/"],
	["write a file atomically", "pix-runtime/src/atomic-write.ts"],
])("local: %p seeds include %p", (question, want) => {
	const seeds = query(graph, question).filter((h) => h.depth === 0);
	expect(seeds.some((h) => h.node.source_file?.includes(want))).toBe(true);
});

test.each([
	["graph tool once registration", "pix-graph/src/graph.ts", "pix-runtime/src/once.ts"],
	["pipeline atomic write", "pix-graph/src/pipeline.ts", "pix-runtime/src/atomic-write.ts"],
	["cli projectDir paths", "pix-graph/src/cli.ts", "pix-runtime/src/paths.ts"],
])("architecture: %p connects %p to %p with a cited edge", (question, from, to) => {
	const ids = new Set(query(graph, question).map((h) => h.node.id));
	const edge = graph.links.find(
		(l) =>
			ids.has(l.source) &&
			ids.has(l.target) &&
			byId.get(l.source)?.source_file?.includes(from) &&
			byId.get(l.target)?.source_file?.includes(to),
	);
	expect(edge?.source_location).toMatch(/^L\d+$/);
});
