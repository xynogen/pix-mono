import { describe, expect, test } from "bun:test";
import { codeHealth, parseGitLog } from "../src/analyze.ts";
import type { GraphData } from "../src/analyzer.ts";

const file = (path: string) => ({ id: path, label: path, source_file: path });
const dep = (source: string, target: string, relation = "imports") => ({
	source,
	target,
	relation,
});

// core.ts is used by a.ts and b.ts; a.ts is tested; config.ts and b.ts have no edge.
const graph: GraphData = {
	nodes: ["src/core.ts", "src/a.ts", "src/b.ts", "src/config.ts", "tests/a.test.ts"].map(file),
	links: [
		dep("src/a.ts", "src/core.ts"),
		dep("src/b.ts", "src/core.ts", "calls"),
		dep("tests/a.test.ts", "src/a.ts"),
		dep("src/core.ts", "src/core.ts"),
	],
};

describe("parseGitLog", () => {
	test("splits NUL-separated commits into file lists", () => {
		expect(parseGitLog("\0\nsrc/a.ts\nsrc/b.ts\n\0\nsrc/c.ts\n")).toEqual([
			["src/a.ts", "src/b.ts"],
			["src/c.ts"],
		]);
	});
});

describe("codeHealth", () => {
	const commits = [
		["src/core.ts", "src/a.ts"],
		["src/core.ts"],
		["src/b.ts", "src/config.ts"],
		["src/b.ts", "src/config.ts", "tests/a.test.ts"],
		["src/b.ts", "src/config.ts", "README.md"],
	];
	const h = codeHealth(graph, commits);

	test("hotspots rank churn by production dependents and skip leaf files", () => {
		expect(h.hotspots).toEqual([{ file: "src/core.ts", commits: 2, dependents: 2 }]);
	});

	test("coupling lists co-changed files without a dependency edge", () => {
		expect(h.coupling).toEqual([{ a: "src/b.ts", b: "src/config.ts", shared: 3, ratio: 1 }]);
	});

	test("untested lists depended-on files no test touches", () => {
		expect(h.untested).toEqual([{ file: "src/core.ts", dependents: 2 }]);
	});

	test("bulk commits count as churn but not as coupling", () => {
		const bulk = Array.from({ length: 31 }, (_, i) => `src/gen${i}.ts`);
		const g: GraphData = { nodes: [...graph.nodes, ...bulk.map(file)], links: graph.links };
		const big = [...bulk, "src/b.ts", "src/config.ts"];
		expect(codeHealth(g, [big, big, big]).coupling).toEqual([]);
	});

	test("without history only untested is reported", () => {
		const empty = codeHealth(graph, []);
		expect(empty.hotspots).toEqual([]);
		expect(empty.coupling).toEqual([]);
		expect(empty.untested).toHaveLength(1);
	});
});
