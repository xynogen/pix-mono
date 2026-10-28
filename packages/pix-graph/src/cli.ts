#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import { projectDir } from "@xynogen/pix-runtime/paths";
import type { GraphData } from "./analyzer.ts";
import { buildCodeGraph } from "./pipeline.ts";
import { query, shortestPath } from "./query.ts";

const USAGE = `pix-graph — native code knowledge graph (TS/JS + ast-grep languages)

Usage:
  pix-graph build [path] [--out DIR] [--root DIR]   Build graph.json + report from code
  pix-graph query "<question>" [--graph FILE] [--dfs] [--depth N]
  pix-graph path "<from>" "<to>" [--graph FILE]      Shortest path between two nodes
`;

// Value flags must be declared, or a flag's value (`--out X`) is taken as the
// first positional (the input path / the question).
function parse(args: string[]) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			out: { type: "string" },
			root: { type: "string" },
			graph: { type: "string" },
			depth: { type: "string" },
			dfs: { type: "boolean" },
		},
	});
	return { values, positionals };
}

function loadGraph(path: string): GraphData {
	try {
		return JSON.parse(readFileSync(resolve(path), "utf8")) as GraphData;
	} catch (error) {
		const detail = getErrorMessage(error);
		throw new Error(`Unable to read graph ${path}: ${detail}`, { cause: error });
	}
}

function main(argv: string[]): void {
	const [command, ...rest] = argv;
	if (!command || command === "--help" || command === "-h") {
		process.stdout.write(USAGE);
		return;
	}
	const { values, positionals } = parse(rest);

	if (command === "build") {
		const input = positionals[0] ?? ".";
		const root = resolve(values.root ?? process.cwd());
		const out = resolve(values.out ?? `${projectDir()}/graph`);
		const result = buildCodeGraph(input, root, out);
		process.stdout.write(
			`Graph: ${result.nodes} nodes, ${result.links} links, ${result.communities} communities → ${result.outputDir}\n`,
		);
		return;
	}

	const graphPath = values.graph ?? `${projectDir()}/graph/graph.cleaned.json`;

	if (command === "query") {
		const question = positionals[0];
		if (!question) throw new Error('query requires a question, e.g. query "how does auth work"');
		const depth = Number(values.depth ?? "2");
		const hits = query(loadGraph(graphPath), question, {
			mode: values.dfs ? "dfs" : "bfs",
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
		const [from, to] = positionals;
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
	console.error(getErrorMessage(error));
	process.exitCode = 1;
}
