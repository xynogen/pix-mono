import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { godNodes, surprisingConnections } from "./analyze.js";
import { analyzeGraph, analyzeGraphProgress } from "./analyzer.js";
import { buildGraph } from "./build.js";
import { collectFiles, extract, parseFilesProgress } from "./extract.js";
import { renderGraphReport } from "./report.js";

/** Result of a full build — the graph and where it landed on disk. */
export interface BuildResult {
	files: number;
	nodes: number;
	links: number;
	communities: number;
	outputDir: string;
}

/** Ordered build phases, for progress reporting. */
export const BUILD_PHASES = ["scan", "extract", "cluster", "analyze", "write"] as const;
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
	cluster: 0.2,
	analyze: 0.15,
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

/**
 * Full code-graph pipeline: extract → build/cluster → analyze → clean → write.
 * Writes graph.json, graph.cleaned.json, and GRAPH_REPORT.md under `outputDir`.
 */
export function buildCodeGraph(
	inputPath: string,
	repoRoot: string,
	outputDir: string,
): BuildResult {
	const files = collectFiles(resolve(inputPath));
	const built = buildGraph(extract(files, repoRoot));
	const fileCount = files.length;
	const gods = godNodes(built.graph);
	const surprises = surprisingConnections(built.graph, built.communities);
	const report = renderGraphReport({ ...built, gods, surprises });
	const cleaned = analyzeGraph(built.graph, { repoRoot });

	mkdirSync(outputDir, { recursive: true });
	writeFileSync(resolve(outputDir, "graph.json"), `${JSON.stringify(built.graph, null, 2)}\n`);
	writeFileSync(
		resolve(outputDir, "graph.cleaned.json"),
		`${JSON.stringify(cleaned.cleanedGraph, null, 2)}\n`,
	);
	writeFileSync(resolve(outputDir, "GRAPH_REPORT.md"), report);

	return {
		files: fileCount,
		nodes: built.graph.nodes.length,
		links: built.graph.links.length,
		communities: built.communities.size,
		outputDir,
	};
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
): Promise<BuildResult> {
	const checkAbort = (): void => {
		if (signal?.aborted) throw new Error("Operation aborted");
	};

	onProgress({ phase: "scan", fraction: 0, label: "scanning files…" });
	await yieldToLoop();
	checkAbort();
	const files = collectFiles(resolve(inputPath));
	const fileCount = files.length;
	onProgress({ phase: "scan", fraction: PHASE_WEIGHT.scan, label: `${fileCount} files` });

	// Parse files in yielding chunks (the slow half of extraction) so the widget
	// animates, then run the whole-corpus extract pass on the pre-parsed list
	// (cross-file call inference needs every declaration first).
	const parsed = await parseFilesProgress(
		files,
		repoRoot,
		(done, total) => {
			onProgress({
				phase: "extract",
				fraction: phaseStart("extract") + PHASE_WEIGHT.extract * 0.8 * (done / Math.max(1, total)),
				label: `parse ${done}/${total} files`,
			});
		},
		signal,
	);
	checkAbort();
	onProgress({
		phase: "extract",
		fraction: phaseStart("extract") + PHASE_WEIGHT.extract * 0.9,
		label: `resolve ${fileCount} files`,
	});
	await yieldToLoop();
	const extraction = extract(parsed, repoRoot);

	checkAbort();
	onProgress({
		phase: "cluster",
		fraction: phaseStart("cluster"),
		label: "clustering communities…",
	});
	await yieldToLoop();
	const built = buildGraph(extraction);

	checkAbort();
	const gods = godNodes(built.graph);
	const surprises = surprisingConnections(built.graph, built.communities);
	const report = renderGraphReport({ ...built, gods, surprises });
	// Call-edge validation re-parses source files and is the slowest step; run the
	// yielding variant so the progress widget keeps animating throughout.
	const cleaned = await analyzeGraphProgress(built.graph, {
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
	onProgress({ phase: "write", fraction: phaseStart("write"), label: "writing output…" });
	await yieldToLoop();
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(resolve(outputDir, "graph.json"), `${JSON.stringify(built.graph, null, 2)}\n`);
	writeFileSync(
		resolve(outputDir, "graph.cleaned.json"),
		`${JSON.stringify(cleaned.cleanedGraph, null, 2)}\n`,
	);
	writeFileSync(resolve(outputDir, "GRAPH_REPORT.md"), report);

	onProgress({ phase: "write", fraction: 1, label: "done" });
	return {
		files: fileCount,
		nodes: built.graph.nodes.length,
		links: built.graph.links.length,
		communities: built.communities.size,
		outputDir,
	};
}
