import type { GraphData, GraphNode } from "./analyzer.ts";

/** One traversal step: a matched node plus how it was reached. */
export interface QueryHit {
	node: GraphNode;
	depth: number;
	via?: string; // relation of the edge that reached it
}

export interface QueryOptions {
	mode?: "bfs" | "dfs";
	maxDepth?: number;
	limit?: number;
}

// Common English + question filler words that carry no code signal. Without
// this filter, "how"/"does" substring-match noise like showStatus/doesExist and
// drown the real seeds.
const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"how",
	"does",
	"did",
	"what",
	"when",
	"where",
	"which",
	"who",
	"why",
	"are",
	"was",
	"were",
	"can",
	"could",
	"would",
	"should",
	"will",
	"with",
	"from",
	"into",
	"this",
	"that",
	"these",
	"those",
	"there",
	"here",
	"work",
	"works",
	"use",
	"used",
	"uses",
	"get",
	"set",
	"has",
	"have",
	"its",
	"our",
	"your",
	"all",
	"any",
	"out",
	"via",
	"you",
]);

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/**
 * Score a node against query terms. A whole-word hit in the label (the node's
 * identity) scores highest; a label substring next; then id/path substrings.
 * This keeps `clustering` from being outranked by `showStatus` matching `how`.
 */
function seedScore(node: GraphNode, terms: string[]): number {
	const rawLabel = node.label ?? "";
	const label = rawLabel.toLowerCase();
	const rest = `${node.id} ${node.source_file ?? ""}`.toLowerCase();
	// Split label into word fragments (camelCase, snake, punctuation) before lowercasing.
	const labelWords = new Set(
		rawLabel
			.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ")
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean),
	);
	let score = 0;
	for (const term of terms) {
		if (labelWords.has(term)) score += 5;
		// Prefix overlap catches inflections: `clustering` ↔ `cluster`.
		else if ([...labelWords].some((w) => sharePrefix(w, term))) score += 4;
		else if (label.includes(term)) score += 2;
		else if (rest.includes(term)) score += 1;
	}
	return score;
}

/** Dependency edges PageRank follows: a node gains rank from what calls, uses or imports it. */
const RANK_RELATIONS = new Set(["calls", "references", "imports"]);

/**
 * PageRank over dependency edges (damping 0.85, 20 iterations). Dangling rank is spread
 * evenly so the scores keep summing to 1. Only orders lexical ties, so a rough fixed
 * iteration count is enough.
 */
export function pageRank(graph: GraphData, iterations = 20, damping = 0.85): Map<string, number> {
	const ids = graph.nodes.map((n) => n.id);
	const n = ids.length;
	if (n === 0) return new Map();
	const out = new Map<string, string[]>();
	for (const l of graph.links) {
		if (!RANK_RELATIONS.has(l.relation)) continue;
		out.set(l.source, [...(out.get(l.source) ?? []), l.target]);
	}
	let rank = new Map(ids.map((id) => [id, 1 / n]));
	for (let i = 0; i < iterations; i++) {
		const next = new Map(ids.map((id) => [id, (1 - damping) / n]));
		let dangling = 0;
		for (const id of ids) {
			const r = rank.get(id) ?? 0;
			const targets = out.get(id)?.filter((t) => next.has(t)) ?? [];
			if (targets.length === 0) dangling += r;
			for (const t of targets) next.set(t, (next.get(t) ?? 0) + (damping * r) / targets.length);
		}
		for (const id of ids) next.set(id, (next.get(id) ?? 0) + (damping * dangling) / n);
		rank = next;
	}
	return rank;
}

/**
 * True if two words share a stem: a common prefix of ≥4 chars that covers the shorter word
 * except for at most a 3-char inflection (cluster/clustered, resolve/resolution), so that
 * unrelated words with one short prefix (communities/commands) do not match.
 */
export function sharePrefix(a: string, b: string): boolean {
	const n = Math.min(a.length, b.length);
	if (n < 4) return false;
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return i >= Math.max(4, n - 3);
}

/**
 * Lexical query: match keywords against node names, then traverse from the
 * best-matching seed nodes. BFS gives broad neighborhood context (default);
 * DFS traces a specific path. Returns ranked hits — the caller narrates them.
 * Ties in the lexical score go to the more central node (PageRank over dependency
 * edges), so a symbol the codebase uses outranks a same-named local in a test.
 * ponytail: lexical seed match, no embeddings. Upgrade path: rank seeds with a
 * real similarity model if recall proves weak.
 */
export function query(graph: GraphData, question: string, options: QueryOptions = {}): QueryHit[] {
	const { mode = "bfs", maxDepth = 2, limit = 25 } = options;
	const terms = tokenize(question);
	if (terms.length === 0) return [];

	const scored = graph.nodes
		.map((node) => ({ node, score: seedScore(node, terms) }))
		.filter((x) => x.score > 0);
	const rank = scored.length > 5 ? pageRank(graph) : new Map<string, number>();
	const seeds = scored
		.sort((a, b) => b.score - a.score || (rank.get(b.node.id) ?? 0) - (rank.get(a.node.id) ?? 0))
		.slice(0, 5)
		.map((x) => x.node);
	if (seeds.length === 0) return [];

	const adj = new Map<string, Array<{ id: string; relation: string }>>();
	for (const node of graph.nodes) adj.set(node.id, []);
	for (const link of graph.links) {
		adj.get(link.source)?.push({ id: link.target, relation: link.relation });
		adj.get(link.target)?.push({ id: link.source, relation: link.relation });
	}
	const byNode = new Map(graph.nodes.map((n) => [n.id, n]));

	const hits: QueryHit[] = [];
	const visited = new Set<string>();
	// Stack for DFS, queue for BFS — both drain `frontier`.
	const frontier: Array<{ id: string; depth: number; via?: string }> = seeds.map((s) => ({
		id: s.id,
		depth: 0,
	}));
	while (frontier.length > 0 && hits.length < limit) {
		const item = mode === "dfs" ? frontier.pop() : frontier.shift();
		if (!item || visited.has(item.id)) continue;
		visited.add(item.id);
		const node = byNode.get(item.id);
		if (node) hits.push({ node, depth: item.depth, ...(item.via ? { via: item.via } : {}) });
		if (item.depth >= maxDepth) continue;
		for (const edge of adj.get(item.id) ?? []) {
			if (!visited.has(edge.id)) {
				frontier.push({ id: edge.id, depth: item.depth + 1, via: edge.relation });
			}
		}
	}
	return hits;
}

/** Shortest path (undirected, unweighted) between two nodes by id or label. */
export function shortestPath(graph: GraphData, from: string, to: string): GraphNode[] {
	const resolve = (needle: string): string | undefined => {
		const lower = needle.toLowerCase();
		return graph.nodes.find((n) => n.id === needle || (n.label ?? "").toLowerCase() === lower)?.id;
	};
	const start = resolve(from);
	const goal = resolve(to);
	if (!start || !goal) return [];

	const adj = new Map<string, string[]>();
	for (const node of graph.nodes) adj.set(node.id, []);
	for (const link of graph.links) {
		adj.get(link.source)?.push(link.target);
		adj.get(link.target)?.push(link.source);
	}
	const byNode = new Map(graph.nodes.map((n) => [n.id, n]));

	const prev = new Map<string, string>();
	const seen = new Set([start]);
	const queue = [start];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		if (current === goal) break;
		for (const next of adj.get(current) ?? []) {
			if (seen.has(next)) continue;
			seen.add(next);
			prev.set(next, current);
			queue.push(next);
		}
	}
	if (start !== goal && !prev.has(goal)) return [];

	const path: string[] = [goal];
	while (path[0] !== start) {
		const p = prev.get(path[0] as string);
		if (!p) return [];
		path.unshift(p);
	}
	return path.map((id) => byNode.get(id)).filter((n): n is GraphNode => n !== undefined);
}

export interface ImpactResult {
	/** Nodes the target resolved to. Empty means no match. */
	seeds: GraphNode[];
	/** Seeds (depth 0) and their dependents, in tree preorder. `via` reads from the parent. */
	hits: QueryHit[];
	/** Distinct files of the dependents (seeds excluded), sorted. */
	files: string[];
	/** Subset of `files` that are tests. */
	tests: string[];
	/** True when `limit` cut the walk short. */
	truncated: boolean;
}

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|tests?)\//;
const bare = (label: string): string => label.replace(/\(\)$/, "");

/**
 * Resolve `target` to seed nodes: exact id, then symbol/file label (`foo` matches `foo()`),
 * then file path suffix. `inFile` narrows an ambiguous label by path fragment.
 */
function impactSeeds(graph: GraphData, target: string, inFile?: string): GraphNode[] {
	const byId = graph.nodes.find((n) => n.id === target);
	if (byId) return [byId];
	const want = bare(target).toLowerCase();
	const scoped = inFile ? graph.nodes.filter((n) => n.source_file?.includes(inFile)) : graph.nodes;
	const byLabel = scoped.filter((n) => bare(n.label ?? "").toLowerCase() === want);
	if (byLabel.length > 0) return byLabel;
	return scoped.filter((n) => !n.source_location && n.source_file?.endsWith(target));
}

/** Dependency edges impact follows backwards, and how each reads from the dependent side. */
const VIA: Record<string, string> = {
	calls: "called by",
	references: "used by",
	imports: "imported by",
};

/**
 * Reverse dependency walk: who calls, references or imports `target`, transitively.
 * Answers "what breaks if I change this?" before an edit leaves callers behind. A file
 * seed also counts dependents of the symbols it contains. Only dependency edges are
 * followed, against their direction, so callees and siblings never leak in.
 */
export function impact(
	graph: GraphData,
	target: string,
	options: { inFile?: string; maxDepth?: number; limit?: number } = {},
): ImpactResult {
	const { inFile, maxDepth = 3, limit = 60 } = options;
	const seeds = impactSeeds(graph, target.trim(), inFile?.trim() || undefined);
	const empty = { seeds, hits: [], files: [], tests: [], truncated: false };
	if (seeds.length === 0) return empty;

	const incoming = new Map<string, Array<{ id: string; relation: string }>>();
	const contains = new Map<string, string[]>();
	const ownerOf = new Map<string, string>();
	for (const link of graph.links) {
		if (link.relation === "contains") {
			contains.set(link.source, [...(contains.get(link.source) ?? []), link.target]);
			ownerOf.set(link.target, link.source);
		} else if (link.relation in VIA) {
			const list = incoming.get(link.target) ?? [];
			list.push({ id: link.source, relation: link.relation });
			incoming.set(link.target, list);
		}
	}
	const byNode = new Map(graph.nodes.map((n) => [n.id, n]));
	const seedIds = new Set(seeds.map((s) => s.id));
	const isTest = (id: string) => TEST_FILE.test(byNode.get(id)?.source_file ?? "");
	// A file seed also owns its symbols' callers. Deeper files do not: that would pull in
	// callers of unrelated symbols that merely share a file with a dependent.
	// A symbol seed also reaches tests that import or mock its file (`vi.mock("./x")`)
	// without calling it; non-test importers stay out, since they may use other symbols.
	const dependents = (id: string) => {
		const node = byNode.get(id);
		const own = seedIds.has(id) && !node?.source_location ? (contains.get(id) ?? []) : [];
		const file = seedIds.has(id) && node?.source_location ? ownerOf.get(id) : undefined;
		const tests = file
			? (incoming.get(file) ?? []).filter((e) => e.relation === "imports" && isTest(e.id))
			: [];
		return [...[id, ...own].flatMap((x) => incoming.get(x) ?? []), ...tests];
	};

	// BFS for shortest depth; remember the parent so the output reads as a tree.
	const children = new Map<string, Array<{ id: string; via: string; depth: number }>>();
	const seen = new Set(seedIds);
	let frontier = [...seedIds];
	let count = 0;
	let truncated = false;
	for (let depth = 1; depth <= maxDepth && frontier.length > 0 && !truncated; depth++) {
		const next: string[] = [];
		for (const id of frontier) {
			for (const edge of dependents(id)) {
				if (seen.has(edge.id)) continue;
				if (count >= limit) {
					truncated = true;
					break;
				}
				seen.add(edge.id);
				count++;
				const via = VIA[edge.relation] ?? edge.relation;
				children.set(id, [...(children.get(id) ?? []), { id: edge.id, via, depth }]);
				next.push(edge.id);
			}
		}
		frontier = next;
	}

	const hits: QueryHit[] = [];
	const emit = (id: string, depth: number, via?: string): void => {
		const node = byNode.get(id);
		if (node) hits.push({ node, depth, ...(via ? { via } : {}) });
		for (const c of children.get(id) ?? []) emit(c.id, c.depth, c.via);
	};
	for (const seed of seeds) emit(seed.id, 0);

	const files = [
		...new Set(
			hits.flatMap((h) => (h.depth > 0 && h.node.source_file ? [h.node.source_file] : [])),
		),
	].sort();
	return { seeds, hits, files, tests: files.filter((f) => TEST_FILE.test(f)), truncated };
}
