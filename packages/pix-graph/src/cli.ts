#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphData } from "./analyzer.js";
import { buildCodeGraph } from "./pipeline.js";
import { query, shortestPath } from "./query.js";

const USAGE = `pix-graph — native TS code knowledge graph

Usage:
  pix-graph build [path] [--out DIR] [--root DIR]   Build graph.json + report from code
  pix-graph query "<question>" [--graph FILE] [--dfs] [--depth N]
  pix-graph path "<from>" "<to>" [--graph FILE]      Shortest path between two nodes
`;

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

function loadGraph(path: string): GraphData {
	try {
		return JSON.parse(readFileSync(resolve(path), "utf8")) as GraphData;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read graph ${path}: ${detail}`, { cause: error });
	}
}

function main(argv: string[]): void {
	const [command, ...args] = argv;
	if (!command || command === "--help" || command === "-h") {
		process.stdout.write(USAGE);
		return;
	}

	if (command === "build") {
		const input = args.find((a) => !a.startsWith("--")) ?? ".";
		const root = resolve(flag(args, "--root") ?? process.cwd());
		const out = resolve(flag(args, "--out") ?? ".pi/pix-graph");
		const result = buildCodeGraph(input, root, out);
		process.stdout.write(
			`Graph: ${result.nodes} nodes, ${result.links} links, ${result.communities} communities → ${result.outputDir}\n`,
		);
		return;
	}

	const graphPath = flag(args, "--graph") ?? ".pi/pix-graph/graph.cleaned.json";

	if (command === "query") {
		const question = args.find((a) => !a.startsWith("--"));
		if (!question) throw new Error('query requires a question, e.g. query "how does auth work"');
		const depth = Number(flag(args, "--depth") ?? "2");
		const hits = query(loadGraph(graphPath), question, {
			mode: args.includes("--dfs") ? "dfs" : "bfs",
			maxDepth: Number.isFinite(depth) ? depth : 2,
		});
		if (hits.length === 0) {
			process.stdout.write("No matching nodes.\n");
			return;
		}
		for (const hit of hits) {
			const via = hit.via ? ` (via ${hit.via})` : "";
			process.stdout.write(
				`${"  ".repeat(hit.depth)}${hit.node.label ?? hit.node.id}${via} — ${hit.node.source_file ?? "?"}\n`,
			);
		}
		return;
	}

	if (command === "path") {
		const positional = args.filter((a) => !a.startsWith("--"));
		const [from, to] = positional;
		if (!from || !to) throw new Error('path requires two arguments: path "A" "B"');
		const nodes = shortestPath(loadGraph(graphPath), from, to);
		if (nodes.length === 0) {
			process.stdout.write("No path found.\n");
			return;
		}
		process.stdout.write(`${nodes.map((n) => n.label ?? n.id).join(" → ")}\n`);
		return;
	}

	throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}

try {
	main(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
