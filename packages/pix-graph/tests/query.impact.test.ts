import { expect, test } from "bun:test";
import type { GraphData } from "../src/analyzer.ts";
import { impact, pageRank, query } from "../src/query.ts";

// a.ts: hash()  ←calls─ b.ts: save()  ←calls─ c.ts: run()
// b.test.ts imports b.ts and calls save(); hash() also calls helper() (a callee, not a dependent).
const node = (id: string, label: string, file: string, loc = true) => ({
	id,
	label,
	source_file: file,
	...(loc ? { source_location: "L1" } : {}),
});
const graph: GraphData = {
	nodes: [
		node("a", "a.ts", "src/a.ts", false),
		node("a_hash", "hash()", "src/a.ts"),
		node("a_helper", "helper()", "src/a.ts"),
		node("b", "b.ts", "src/b.ts", false),
		node("b_save", "save()", "src/b.ts"),
		node("b_other", "other()", "src/b.ts"),
		node("c_run", "run()", "src/c.ts"),
		node("d_lone", "lone()", "src/d.ts"),
		node("t", "b.test.ts", "src/b.test.ts", false),
	],
	links: [
		{ source: "a", target: "a_hash", relation: "contains" },
		{ source: "b", target: "b_save", relation: "contains" },
		{ source: "b", target: "b_other", relation: "contains" },
		{ source: "a_hash", target: "a_helper", relation: "calls" },
		{ source: "b_save", target: "a_hash", relation: "calls" },
		{ source: "c_run", target: "b_save", relation: "calls" },
		{ source: "d_lone", target: "b_other", relation: "calls" },
		{ source: "t", target: "b", relation: "imports" },
		{ source: "t", target: "b_save", relation: "calls" },
	],
};

test("symbol impact walks callers transitively, never callees or file siblings", () => {
	const r = impact(graph, "hash");
	expect(r.hits.map((h) => [h.node.id, h.depth, h.via])).toEqual([
		["a_hash", 0, undefined],
		["b_save", 1, "called by"],
		["c_run", 2, "called by"],
		["t", 2, "called by"],
	]);
	expect(r.files).toEqual(["src/b.test.ts", "src/b.ts", "src/c.ts"]);
	expect(r.tests).toEqual(["src/b.test.ts"]);
});

test("file impact includes importers and callers of its own symbols", () => {
	const ids = impact(graph, "src/b.ts").hits.map((h) => h.node.id);
	expect(new Set(ids)).toEqual(new Set(["b", "t", "c_run", "d_lone"]));
});

test("symbol impact reaches tests that only import or mock its file", () => {
	const g: GraphData = {
		nodes: [
			node("x", "x.ts", "src/x.ts", false),
			node("x_fn", "fn()", "src/x.ts"),
			node("m", "m.test.ts", "src/m.test.ts", false),
			node("p", "page.ts", "src/page.ts", false),
		],
		links: [
			{ source: "x", target: "x_fn", relation: "contains" },
			{ source: "m", target: "x", relation: "imports" },
			{ source: "p", target: "x", relation: "imports" },
		],
	};
	const r = impact(g, "fn");
	expect(r.tests).toEqual(["src/m.test.ts"]);
	// A non-test importer may use other symbols of the file, so it is not a dependent of fn().
	expect(r.files).toEqual(["src/m.test.ts"]);
});

test("pageRank favors depended-on nodes; query breaks lexical ties with it", () => {
	const rank = pageRank(graph);
	const sum = [...rank.values()].reduce((a, b) => a + b, 0);
	expect(sum).toBeCloseTo(1, 6);
	// hash() is called by save(); lone() calls nothing and nothing calls it.
	expect(rank.get("a_hash") ?? 0).toBeGreaterThan(rank.get("d_lone") ?? 0);

	// Six same-named seeds force the tie-break; the one with callers wins.
	const tied: GraphData = {
		nodes: [
			...Array.from({ length: 6 }, (_, i) => node(`t${i}`, "theme", `src/t${i}.test.ts`)),
			node("user", "use()", "src/u.ts"),
		],
		links: [{ source: "user", target: "t4", relation: "references" }],
	};
	expect(query(tied, "theme", { maxDepth: 0 })[0]?.node.id).toBe("t4");
});

test("maxDepth, limit and inFile bound the walk", () => {
	expect(impact(graph, "hash", { maxDepth: 1 }).hits).toHaveLength(2);
	expect(impact(graph, "hash", { limit: 1 }).truncated).toBe(true);
	expect(impact(graph, "save", { inFile: "src/a.ts" }).seeds).toEqual([]);
	expect(impact(graph, "nope").hits).toEqual([]);
});
