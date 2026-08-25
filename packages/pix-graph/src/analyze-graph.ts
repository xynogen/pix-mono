#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { analyzeGraph, type GraphData, renderPatternReport } from "./analyzer.js";

interface CliOptions {
	graphPath: string;
	outputDirectory: string;
	repoRoot: string;
}

function valueAfter(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function parseArgs(args: string[]): CliOptions {
	let graphPath = "graphify-out/graph.json";
	let outputDirectory: string | undefined;
	let repoRoot = process.cwd();
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--graph") {
			graphPath = valueAfter(args, index, argument);
			index += 1;
		} else if (argument === "--out") {
			outputDirectory = valueAfter(args, index, argument);
			index += 1;
		} else if (argument === "--root") {
			repoRoot = valueAfter(args, index, argument);
			index += 1;
		} else if (argument === "--help" || argument === "-h") {
			process.stdout.write(
				"Usage: bun scripts/analyze-graph.ts [--graph PATH] [--out DIRECTORY] [--root DIRECTORY]\n",
			);
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${argument}`);
		}
	}
	const resolvedGraphPath = resolve(graphPath);
	return {
		graphPath: resolvedGraphPath,
		outputDirectory: resolve(outputDirectory ?? dirname(resolvedGraphPath)),
		repoRoot: resolve(repoRoot),
	};
}

function readGraph(path: string): GraphData {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as GraphData;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read graph ${path}: ${detail}`, { cause: error });
	}
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	const graph = readGraph(options.graphPath);
	const result = analyzeGraph(graph, { repoRoot: options.repoRoot });
	mkdirSync(options.outputDirectory, { recursive: true });
	writeFileSync(
		resolve(options.outputDirectory, "graph.cleaned.json"),
		`${JSON.stringify(result.cleanedGraph, null, 2)}\n`,
	);
	writeFileSync(
		resolve(options.outputDirectory, "patterns.json"),
		`${JSON.stringify({ quality: result.quality, patterns: result.patterns }, null, 2)}\n`,
	);
	writeFileSync(resolve(options.outputDirectory, "PATTERN_REPORT.md"), renderPatternReport(result));
	process.stdout.write(
		`Graph analyzed: ${result.patterns.repeatedStructures.length} repeated structures, ${result.patterns.semanticPatterns.length} semantic patterns, ${result.quality.removedSuspiciousEdges.length} unreliable links removed.\n`,
	);
	process.stdout.write(`Outputs: ${options.outputDirectory}\n`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
