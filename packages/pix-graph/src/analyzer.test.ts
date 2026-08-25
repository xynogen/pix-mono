import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeGraph, type GraphData, renderPatternReport } from "./analyzer.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pix-graph-analyzer-"));
	temporaryDirectories.push(root);
	mkdirSync(join(root, "packages/a/src"), { recursive: true });
	mkdirSync(join(root, "packages/b/src"), { recursive: true });
	writeFileSync(
		join(root, "packages/a/src/main.ts"),
		[
			'import { readFile } from "node:fs/promises";',
			`import { icon } from ${'"@xynogen/b/icon"'};`,
			"export async function load() {",
			'\tawait readFile("input.txt");',
			'\ticon("model");',
			"}",
			"export function invoke(execute: () => void) {",
			"\treturn execute();",
			"}",
		].join("\n"),
	);
	writeFileSync(join(root, "packages/a/src/once.ts"), "export const once = () => true;\n");
	writeFileSync(join(root, "packages/b/src/once.ts"), "export const once = () => true;\n");
	return root;
}

function fixtureGraph(root: string): GraphData {
	return {
		directed: false,
		multigraph: false,
		nodes: [
			{
				id: "a_load",
				label: "load()",
				community: 1,
				file_type: "code",
				source_file: join(root, "packages/a/src/main.ts"),
				source_location: "L3",
			},
			{
				id: "a_invoke",
				label: "invoke()",
				community: 1,
				file_type: "code",
				source_file: "packages/a/src/main.ts",
				source_location: "L7",
			},
			{
				id: "b_read_file",
				label: "readFile()",
				community: 2,
				file_type: "code",
				source_file: "packages/b/src/cache.ts",
				source_location: "L1",
			},
			{
				id: "b_icon",
				label: "icon()",
				community: 2,
				file_type: "code",
				source_file: "packages/b/src/icon.ts",
				source_location: "L1",
			},
			{
				id: "b_execute",
				label: "execute()",
				community: 2,
				file_type: "code",
				source_file: "packages/b/src/execute.ts",
				source_location: "L1",
			},
			{
				id: "once_a_file",
				label: "once.ts",
				community: 10,
				file_type: "code",
				source_file: "packages/a/src/once.ts",
			},
			{
				id: "once_a_function",
				label: "once()",
				community: 10,
				file_type: "code",
				source_file: "packages/a/src/once.ts",
			},
			{
				id: "once_b_file",
				label: "once.ts",
				community: 11,
				file_type: "code",
				source_file: "packages/b/src/once.ts",
			},
			{
				id: "once_b_function",
				label: "once()",
				community: 11,
				file_type: "code",
				source_file: "packages/b/src/once.ts",
			},
		],
		links: [
			{
				source: "a_load",
				target: "b_read_file",
				relation: "calls",
				confidence: "INFERRED",
				confidence_score: 0.8,
				source_file: "packages/a/src/main.ts",
				source_location: "L4",
			},
			{
				source: "a_load",
				target: "b_icon",
				relation: "calls",
				confidence: "INFERRED",
				confidence_score: 0.8,
				source_file: "packages/a/src/main.ts",
				source_location: "L5",
			},
			{
				source: "a_invoke",
				target: "b_execute",
				relation: "calls",
				confidence: "INFERRED",
				confidence_score: 0.8,
				source_file: "packages/a/src/main.ts",
				source_location: "L8",
			},
		],
		hyperedges: [
			{
				id: "valid",
				label: "Valid pattern",
				nodes: ["a_load", "b_icon", "once_a_function"],
				relation: "form",
			},
			{
				id: null,
				label: "Recoverable pattern",
				nodes: ["a_load", "b_icon", "once_b_function"],
				relation: "form",
			},
			{ id: "empty", label: "Empty pattern", nodes: [], relation: "form" },
			{
				id: "missing",
				label: "Missing member",
				nodes: ["a_load", "b_icon", "not_a_node"],
				relation: "form",
			},
		],
	};
}

describe("graph analyzer", () => {
	test("normalizes paths and removes invalid inferred calls and hyperedges", () => {
		const root = fixtureRoot();
		const result = analyzeGraph(fixtureGraph(root), { repoRoot: root });

		expect(result.cleanedGraph.nodes[0]?.source_file).toBe("packages/a/src/main.ts");
		expect(result.cleanedGraph.links.map((edge) => edge.target)).toEqual(["b_icon"]);
		expect(result.cleanedGraph.hyperedges?.map((edge) => edge.id)).toEqual([
			"valid",
			"pattern_recoverable_pattern",
		]);
		expect(result.quality.removedSuspiciousEdges).toHaveLength(2);
		expect(result.quality.invalidHyperedges).toHaveLength(2);
		expect(result.quality.repairedHyperedgeIds).toEqual([
			{ id: "pattern_recoverable_pattern", label: "Recoverable pattern" },
		]);
		expect(result.quality.normalizedSourcePaths).toBeGreaterThan(0);
	});

	test("extracts repeated structures and renders their evidence", () => {
		const root = fixtureRoot();
		const result = analyzeGraph(fixtureGraph(root), { repoRoot: root });
		const repeated = result.patterns.repeatedStructures.find(
			(pattern) => pattern.communityIds.includes(10) && pattern.communityIds.includes(11),
		);

		expect(repeated).toMatchObject({
			category: "code",
			occurrences: 2,
			labels: ["once()", "once.ts"],
		});
		expect(repeated?.sourceFiles).toEqual(["packages/a/src/once.ts", "packages/b/src/once.ts"]);

		const report = renderPatternReport(result);
		expect(report).toContain("## Repeated code structures");
		expect(report).toContain("`once()` + `once.ts`");
		expect(report).toContain("Valid pattern");
	});

	test("CLI writes a clean graph and machine-readable pattern output", () => {
		const root = fixtureRoot();
		const graphPath = join(root, "graph.json");
		const outputDirectory = join(root, "analysis");
		writeFileSync(graphPath, JSON.stringify(fixtureGraph(root)));

		const child = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "analyze-graph.ts"),
				"--graph",
				graphPath,
				"--out",
				outputDirectory,
				"--root",
				root,
			],
			{ stderr: "pipe", stdout: "pipe" },
		);

		expect(child.exitCode, child.stderr.toString()).toBe(0);
		expect(existsSync(join(outputDirectory, "graph.cleaned.json"))).toBe(true);
		expect(existsSync(join(outputDirectory, "patterns.json"))).toBe(true);
		expect(readFileSync(join(outputDirectory, "PATTERN_REPORT.md"), "utf8")).toContain(
			"# Graph Pattern Report",
		);
	});
});
