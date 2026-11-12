import type { GraphData, GraphNode } from "./analyzer.ts";
import type { Communities } from "./cluster.ts";
import { TEST_FILE } from "./query.ts";

/** A most-connected entity — the core abstractions of the corpus. */
export interface GodNode {
	id: string;
	label: string;
	edges: number;
}

/** A non-obvious cross-boundary connection, with a plain reason. */
export interface Surprise {
	source: string;
	target: string;
	relation: string;
	why: string[];
}

const CONFIDENCE_WEIGHT: Record<string, number> = { AMBIGUOUS: 3, INFERRED: 2, EXTRACTED: 1 };

/** Degree (undirected) for every node. */
function degrees(graph: GraphData): Map<string, number> {
	const deg = new Map<string, number>();
	for (const node of graph.nodes) deg.set(node.id, 0);
	for (const link of graph.links) {
		if (link.source === link.target) continue;
		deg.set(link.source, (deg.get(link.source) ?? 0) + 1);
		deg.set(link.target, (deg.get(link.target) ?? 0) + 1);
	}
	return deg;
}

/** File-level hub or bare method stub — excluded from god nodes. */
function isFileNode(node: GraphNode, degree: number): boolean {
	const label = node.label ?? "";
	if (!label) return false;
	if (node.source_file && label === node.source_file.split("/").at(-1)) return true; // file node
	if (label.startsWith(".") && label.endsWith("()")) return true; // method stub
	if (label.endsWith("()") && degree <= 1) return true; // isolated function
	return false;
}

/** Top-N most-connected real entities (file hubs excluded). */
export function godNodes(graph: GraphData, topN = 10): GodNode[] {
	const deg = degrees(graph);
	const byNode = new Map(graph.nodes.map((n) => [n.id, n]));
	const ranked = [...deg.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	const out: GodNode[] = [];
	for (const [id, d] of ranked) {
		const node = byNode.get(id);
		if (!node || isFileNode(node, d)) continue;
		out.push({ id, label: node.label ?? id, edges: d });
		if (out.length >= topN) break;
	}
	return out;
}

function topDir(path: string): string {
	return path.includes("/") ? (path.split("/")[0] ?? path) : path;
}

/**
 * Cross-file connections ranked by a composite surprise score:
 * confidence (AMBIGUOUS > INFERRED > EXTRACTED), cross-directory, cross-community,
 * and peripheral→hub reach. Each result explains what makes it non-obvious.
 */
export function surprisingConnections(
	graph: GraphData,
	communities: Communities,
	topN = 5,
): Surprise[] {
	const nodeCommunity = new Map<string, number>();
	for (const [cid, members] of communities) for (const m of members) nodeCommunity.set(m, cid);
	const byNode = new Map(graph.nodes.map((n) => [n.id, n]));
	const deg = degrees(graph);

	const scored: Array<{ score: number; s: Surprise }> = [];
	for (const link of graph.links) {
		const u = byNode.get(link.source);
		const v = byNode.get(link.target);
		if (!u || !v) continue;
		const uf = u.source_file ?? "";
		const vf = v.source_file ?? "";
		if (!uf || !vf || uf === vf) continue; // same-file or concept nodes: not surprising

		let score = 0;
		const why: string[] = [];
		const conf = link.confidence ?? "EXTRACTED";
		score += CONFIDENCE_WEIGHT[conf] ?? 1;
		if (conf !== "EXTRACTED") why.push(`${conf.toLowerCase()} connection — not explicit in source`);
		if (typeof u.package === "string" && typeof v.package === "string") {
			if (u.package !== v.package) {
				score += 2;
				why.push(`crosses packages ${u.package} → ${v.package}`);
			}
		} else if (topDir(uf) !== topDir(vf)) {
			score += 2;
			why.push("connects across different directories");
		}
		const cu = nodeCommunity.get(link.source);
		const cv = nodeCommunity.get(link.target);
		if (cu !== undefined && cv !== undefined && cu !== cv) {
			score += 1;
			why.push("bridges separate communities");
		}
		const du = deg.get(link.source) ?? 0;
		const dv = deg.get(link.target) ?? 0;
		if (Math.min(du, dv) <= 2 && Math.max(du, dv) >= 5) {
			score += 1;
			const peripheral = du <= 2 ? u.label : v.label;
			const hub = du <= 2 ? v.label : u.label;
			why.push(`peripheral \`${peripheral}\` unexpectedly reaches hub \`${hub}\``);
		}
		if (why.length > 0) {
			scored.push({
				score,
				s: { source: link.source, target: link.target, relation: link.relation, why },
			});
		}
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, topN).map((x) => x.s);
}

/** A file that is both depended on and often changed: the riskiest code to touch. */
export interface Hotspot {
	file: string;
	commits: number;
	dependents: number;
}

/** Two files that change together but have no dependency edge between them. */
export interface Coupling {
	a: string;
	b: string;
	shared: number;
	/** shared / commits of the less-changed file. */
	ratio: number;
}

/** A depended-on file that no test imports, calls or references directly. */
export interface Untested {
	file: string;
	dependents: number;
}

export interface CodeHealth {
	hotspots: Hotspot[];
	coupling: Coupling[];
	untested: Untested[];
}

const DEPENDENCY = new Set(["imports", "calls", "references"]);
/** Bulk commits (renames, format sweeps) couple everything with everything. */
const MAX_COMMIT_FILES = 30;
const MIN_SHARED = 3;
const MIN_RATIO = 0.5;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** File → distinct other files with a dependency edge into it. */
function fileDependents(graph: GraphData): Map<string, Set<string>> {
	const fileOf = new Map(graph.nodes.map((n) => [n.id, n.source_file ?? undefined]));
	const deps = new Map<string, Set<string>>();
	for (const link of graph.links) {
		if (!DEPENDENCY.has(link.relation)) continue;
		const from = fileOf.get(link.source);
		const to = fileOf.get(link.target);
		if (!from || !to || from === to) continue;
		const set = deps.get(to) ?? new Set<string>();
		set.add(from);
		deps.set(to, set);
	}
	return deps;
}

/** Commits from `git log --format=%x00 --name-only`: one file list per commit. */
export function parseGitLog(text: string): string[][] {
	return text
		.split("\0")
		.map((commit) =>
			commit
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		)
		.filter((files) => files.length > 0);
}

/**
 * Join the graph with git history. Hotspots rank churn × production dependents.
 * Hidden coupling lists file pairs that share at least MIN_SHARED commits and MIN_RATIO
 * of the less-changed file's commits, with no dependency edge either way. Untested lists
 * depended-on files that no test file touches directly. Pass no commits for untested only.
 */
export function codeHealth(graph: GraphData, commits: string[][], topN = 10): CodeHealth {
	const deps = fileDependents(graph);
	const isTest = (file: string) => TEST_FILE.test(file);
	const code = new Set(
		graph.nodes.flatMap((n) => (n.source_file && !isTest(n.source_file) ? [n.source_file] : [])),
	);
	const dependents = (file: string) => [...(deps.get(file) ?? [])].filter((d) => !isTest(d)).length;

	const churn = new Map<string, number>();
	const pairs = new Map<string, number>();
	for (const commit of commits) {
		const files = [...new Set(commit.filter((f) => code.has(f)))].sort(byText);
		for (const f of files) churn.set(f, (churn.get(f) ?? 0) + 1);
		if (files.length > MAX_COMMIT_FILES) continue;
		for (let i = 0; i < files.length; i++)
			for (let j = i + 1; j < files.length; j++) {
				const key = `${files[i]}\0${files[j]}`;
				pairs.set(key, (pairs.get(key) ?? 0) + 1);
			}
	}

	const hotspots = [...churn]
		.map(([file, n]) => ({ file, commits: n, dependents: dependents(file) }))
		.filter((h) => h.dependents > 0)
		.sort((x, y) => y.commits * y.dependents - x.commits * x.dependents || byText(x.file, y.file))
		.slice(0, topN);

	const coupling: Coupling[] = [];
	for (const [key, shared] of pairs) {
		if (shared < MIN_SHARED) continue;
		const [a = "", b = ""] = key.split("\0");
		const ratio = shared / Math.min(churn.get(a) ?? shared, churn.get(b) ?? shared);
		if (ratio < MIN_RATIO || deps.get(a)?.has(b) || deps.get(b)?.has(a)) continue;
		coupling.push({ a, b, shared, ratio });
	}
	coupling.sort((x, y) => y.shared - x.shared || y.ratio - x.ratio || byText(x.a, y.a));

	const untested = [...code]
		.filter((file) => ![...(deps.get(file) ?? [])].some(isTest))
		.map((file) => ({ file, dependents: dependents(file) }))
		.filter((u) => u.dependents > 0)
		.sort((x, y) => y.dependents - x.dependents || byText(x.file, y.file))
		.slice(0, topN);

	return { hotspots, coupling: coupling.slice(0, topN), untested };
}
