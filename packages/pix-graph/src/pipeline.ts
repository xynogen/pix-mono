import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { writeFileAtomicSync } from "@xynogen/pix-runtime/atomic-write";
import { godNodes, surprisingConnections } from "./analyze.ts";
import { analyzeGraph, analyzeGraphProgress, type GraphData } from "./analyzer.ts";
import { buildGraph } from "./build.ts";
import { assignCommunities } from "./cluster.ts";
import {
	collectFiles,
	createGraphParseCache,
	extract,
	type GraphParseCache,
	isTsFile,
	parseFilesProgress,
	type UnresolvedImport,
} from "./extract.ts";
import { extractGeneric, type GenericFile, genericLanguage } from "./generic.ts";

export { createGraphParseCache } from "./extract.ts";

import { renderGraphHtml } from "./html.ts";
import { renderGraphReport } from "./report.ts";

/** Result of a full build — the graph and where it landed on disk. */
export interface BuildResult {
	files: number;
	nodes: number;
	links: number;
	communities: number;
	outputDir: string;
	cached?: boolean;
	parsedFiles?: number;
	reusedFiles?: number;
	/** Files parsed per non-TS language (ast-grep). */
	languages?: Record<string, number>;
	/** Non-TS languages that were found but not parsed, with the reason. */
	skipped?: string[];
}

/** Ordered build phases, for progress reporting. */
export const BUILD_PHASES = ["scan", "extract", "analyze", "cluster", "write"] as const;
export type BuildPhase = (typeof BUILD_PHASES)[number];

/** One progress tick emitted by {@link buildCodeGraphProgress}. */
export interface BuildProgress {
	phase: BuildPhase;
	/** 0..1 fraction of the whole build complete. */
	fraction: number;
	/** Human label, e.g. "extract 120/385 files". */
	label: string;
}

/** Weight of each phase in the overall progress bar (must sum to 1). */
const PHASE_WEIGHT: Record<BuildPhase, number> = {
	scan: 0.05,
	extract: 0.55,
	analyze: 0.15,
	cluster: 0.2,
	write: 0.05,
};

/** Cumulative fraction at the START of each phase. */
function phaseStart(phase: BuildPhase): number {
	let acc = 0;
	for (const p of BUILD_PHASES) {
		if (p === phase) break;
		acc += PHASE_WEIGHT[p];
	}
	return acc;
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
// ponytail: bump this when extraction changes for builds outside the pix-graph source tree.
const CACHE_VERSION = 3;
const CACHE_FILE = ".graph-cache.json";
const OUTPUT_FILES = ["graph.json", "graph.cleaned.json", "GRAPH_REPORT.md", "graph.html"] as const;

type CacheEntry = { key: string; result: BuildResult };

function buildKey(files: string[], repoRoot: string, inputPath: string): string {
	const hash = createHash("sha256");
	hash.update(`${CACHE_VERSION}\0${resolve(repoRoot)}\0${resolve(inputPath)}\0`);
	// A renderer change must rewrite graph.html, or an old page (with old bugs) survives updates.
	hash.update(readFileSync(new URL("./html.ts", import.meta.url)));
	// Workspace import resolution reads package.json name/exports, so those files count too.
	const manifests = new Set<string>();
	for (const file of files) {
		for (let dir = dirname(file); ; dir = dirname(dir)) {
			manifests.add(join(dir, "package.json"));
			if (dir === dirname(dir) || relative(repoRoot, dir) === "") break;
		}
	}
	for (const file of [...files, ...[...manifests].filter((m) => existsSync(m)).sort()]) {
		hash.update(relative(repoRoot, file));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function cachedBuild(outputDir: string, key: string): BuildResult | undefined {
	if (!OUTPUT_FILES.every((file) => existsSync(resolve(outputDir, file)))) return undefined;
	try {
		const cache = JSON.parse(readFileSync(resolve(outputDir, CACHE_FILE), "utf8")) as CacheEntry;
		if (cache.key !== key || !cache.result || cache.result.outputDir !== outputDir)
			return undefined;
		if (
			!Number.isSafeInteger(cache.result.files) ||
			!Number.isSafeInteger(cache.result.nodes) ||
			!Number.isSafeInteger(cache.result.links) ||
			!Number.isSafeInteger(cache.result.communities)
		)
			return undefined;
		return { ...cache.result, cached: true };
	} catch {
		return undefined;
	}
}

/**
 * Cluster the cleaned graph (the one query reads), stamp the same communities on the
 * raw graph, then write graph.json, graph.cleaned.json, GRAPH_REPORT.md, and graph.html.
 */
function clusterAndWrite(
	raw: GraphData,
	cleaned: GraphData,
	unresolved: UnresolvedImport[],
	outputDir: string,
): { links: number; communities: number } {
	const built = buildGraph({ nodes: cleaned.nodes, links: cleaned.links });
	assignCommunities(raw.nodes, built.communities);
	const report = renderGraphReport({
		...built,
		gods: godNodes(built.graph),
		surprises: surprisingConnections(built.graph, built.communities),
		unresolved,
	});
	const cleanedOut = { ...cleaned, ...built.graph, hyperedges: cleaned.hyperedges };
	mkdirSync(outputDir, { recursive: true });
	// Invalidate the old manifest before any output changes. A failed write must rebuild.
	rmSync(resolve(outputDir, CACHE_FILE), { force: true });
	writeFileSync(resolve(outputDir, "graph.json"), `${JSON.stringify(raw, null, 2)}\n`);
	writeFileSync(
		resolve(outputDir, "graph.cleaned.json"),
		`${JSON.stringify(cleanedOut, null, 2)}\n`,
	);
	writeFileSync(resolve(outputDir, "GRAPH_REPORT.md"), report);
	writeFileSync(resolve(outputDir, "graph.html"), renderGraphHtml(cleanedOut));
	return { links: raw.links.length, communities: built.communities.size };
}

function rawGraph(extraction: { nodes: GraphData["nodes"]; links: GraphData["links"] }): GraphData {
	return { directed: false, multigraph: false, nodes: extraction.nodes, links: extraction.links };
}

/**
 * Full code-graph pipeline: extract → analyze/clean → cluster → write.
 * Writes graph.json, graph.cleaned.json, GRAPH_REPORT.md, and graph.html under `outputDir`.
 */
export function buildCodeGraph(
	inputPath: string,
	repoRoot: string,
	outputDir: string,
): BuildResult {
	const files = collectFiles(resolve(inputPath));
	const extraction = extract(files, repoRoot);
	const raw = rawGraph(extraction);
	const cleaned = analyzeGraph(raw, { repoRoot }).cleanedGraph;
	const written = clusterAndWrite(raw, cleaned, extraction.unresolved, outputDir);
	return { files: files.length, nodes: raw.nodes.length, ...written, outputDir };
}

/**
 * Same pipeline as {@link buildCodeGraph}, but async: it yields to the event
 * loop between phases (and periodically while extracting) so a live progress
 * widget can tick. `onProgress` is called with a 0..1 fraction and a label.
 * `signal` aborts cooperatively at phase boundaries.
 */
export async function buildCodeGraphProgress(
	inputPath: string,
	repoRoot: string,
	outputDir: string,
	onProgress: (p: BuildProgress) => void,
	signal?: AbortSignal,
	parseCache: GraphParseCache = createGraphParseCache(),
	/** Asked once per missing grammar; without it, missing grammars are reported as skipped. */
	consent?: (pkg: string) => Promise<boolean>,
): Promise<BuildResult> {
	const checkAbort = (): void => {
		if (signal?.aborted) throw new Error("Operation aborted");
	};

	onProgress({ phase: "scan", fraction: 0, label: "scanning files…" });
	await yieldToLoop();
	checkAbort();
	// TS/JS use the compiler extractor; every other ast-grep language uses the generic one.
	const files = collectFiles(
		resolve(inputPath),
		(p) => isTsFile(p) || genericLanguage(p) !== undefined,
	);
	const tsFiles = files.filter(isTsFile);
	const otherFiles: GenericFile[] = files.flatMap((file) => {
		const lang = isTsFile(file) ? undefined : genericLanguage(file);
		return lang ? [{ file, rel: relative(repoRoot, file).split(sep).join("/"), lang }] : [];
	});
	const fileCount = files.length;
	const key = buildKey(files, repoRoot, inputPath);
	checkAbort();
	const cached = cachedBuild(outputDir, key);
	if (cached) {
		onProgress({ phase: "write", fraction: 1, label: "unchanged — using cached graph" });
		return cached;
	}
	onProgress({ phase: "scan", fraction: PHASE_WEIGHT.scan, label: `${fileCount} files` });

	// Parse files in yielding chunks (the slow half of extraction) so the widget
	// animates, then run the whole-corpus extract pass on the pre-parsed list
	// (import and re-export resolution needs every file first).
	const parsed = await parseFilesProgress(
		tsFiles,
		repoRoot,
		(done, total) => {
			onProgress({
				phase: "extract",
				fraction: phaseStart("extract") + PHASE_WEIGHT.extract * 0.8 * (done / Math.max(1, total)),
				label: `parse ${done}/${total} files`,
			});
		},
		signal,
		40,
		parseCache,
	);
	checkAbort();
	onProgress({
		phase: "extract",
		fraction: phaseStart("extract") + PHASE_WEIGHT.extract * 0.9,
		label: `resolve ${fileCount} files`,
	});
	await yieldToLoop();
	const extraction = extract(parsed, repoRoot);
	const generic = await extractGeneric(
		otherFiles,
		consent,
		(done, total) =>
			onProgress({
				phase: "extract",
				fraction: phaseStart("extract") + PHASE_WEIGHT.extract * 0.95,
				label: `parse other languages ${done}/${total} files`,
			}),
		signal,
	);

	checkAbort();
	const raw = rawGraph({
		nodes: [...extraction.nodes, ...generic.nodes],
		links: [...extraction.links, ...generic.links],
	});
	// Call-edge validation re-parses source files and is the slowest step; run the
	// yielding variant so the progress widget keeps animating throughout.
	const cleaned = await analyzeGraphProgress(raw, {
		repoRoot,
		signal,
		onProgress: (done, total) => {
			onProgress({
				phase: "analyze",
				fraction: phaseStart("analyze") + PHASE_WEIGHT.analyze * (done / Math.max(1, total)),
				label: `analyze ${done}/${total} edges`,
			});
		},
	});

	checkAbort();
	onProgress({
		phase: "cluster",
		fraction: phaseStart("cluster"),
		label: "clustering communities…",
	});
	await yieldToLoop();
	const written = clusterAndWrite(raw, cleaned.cleanedGraph, extraction.unresolved, outputDir);

	const result: BuildResult = {
		files: fileCount,
		nodes: raw.nodes.length,
		...written,
		outputDir,
		cached: false,
		parsedFiles:
			parseCache.parsedFiles + Object.values(generic.languages).reduce((a, b) => a + b, 0),
		reusedFiles: parseCache.reusedFiles,
		...(Object.keys(generic.languages).length ? { languages: generic.languages } : {}),
		...(generic.skipped.length ? { skipped: generic.skipped } : {}),
	};
	// Write the manifest last. An interrupted build cannot mark partial output as current.
	// A build that skipped a language must not be reused once its grammar is installed.
	if (!result.skipped) {
		writeFileAtomicSync(resolve(outputDir, CACHE_FILE), `${JSON.stringify({ key, result })}\n`);
	}
	onProgress({ phase: "write", fraction: 1, label: "done" });
	return result;
}
