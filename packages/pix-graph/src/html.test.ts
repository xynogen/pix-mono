import { describe, expect, test } from "bun:test";
import { graphPageData, renderGraphHtml } from "./html.ts";

const graph = {
	nodes: [
		{
			id: "a",
			label: "</script><b>x",
			community: 7,
			source_file: "pkg/src/a.ts",
			source_location: "L3",
		},
		{ id: "b", label: "b", community: 7, source_file: "pkg/src/b.ts" },
		{ id: "c", label: "c", community: 1, source_file: "other/lib/c.ts" },
	],
	links: [
		{ source: "a", target: "b", relation: "calls" },
		{ source: "b", target: "c", relation: "imports", confidence: "INFERRED" },
		{ source: "a", target: "missing", relation: "calls" },
		{ source: "a", target: "a", relation: "self" },
	],
};

describe("graphPageData", () => {
	test("indexes nodes, keeps valid links, and names communities by folder, largest first", () => {
		expect(graphPageData(graph)).toEqual({
			rels: ["calls", "imports"],
			nodes: [
				["</script><b>x", 0, "pkg/src/a.ts:L3"],
				["b", 0, "pkg/src/b.ts"],
				["c", 1, "other/lib/c.ts"],
			],
			links: [
				[0, 1, 0],
				[1, 2, 1, 1],
			],
			groups: [
				["pkg/src #0", 2],
				["other/lib #1", 1],
			],
		});
	});
});

describe("renderGraphHtml", () => {
	test("embeds the payload once and labels cannot end the script block", () => {
		const html = renderGraphHtml(graph);
		expect(html.match(/<\/script>/g)?.length).toBe(2);
		const json = html.match(/^const DATA = (.*);$/m)?.[1] ?? "null";
		expect(JSON.parse(json)).toEqual(graphPageData(graph));
	});

	test("offers a reversible overview on large graphs without hiding focused links", () => {
		const html = renderGraphHtml(graph);
		expect(html).toContain('<input type="checkbox" id="all-links">Show all links');
		expect(html).toMatch(/N < 1000/);
		expect(html).toMatch(/!showAllLinks && b\.detail/);
		expect(html).toMatch(/if \(near\) drawFocusEdges\(focus, k\)/);
	});

	test("pins the graph box to the viewport so the canvas cannot grow without limit", () => {
		// Regression: an unbounded graph box let the height: 100% canvas grow ~480px/2s.
		const html = renderGraphHtml(graph);
		expect(html).toMatch(/body \{[^}]*height: 100vh;[^}]*overflow: hidden;/);
		expect(html).toMatch(/#graph \{[^}]*min-height: 0;[^}]*overflow: hidden;/);
	});
});
