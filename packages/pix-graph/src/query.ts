import type { GraphData, GraphNode } from "./analyzer.js";

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

function tokenize(text: string): string[] {
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

/** True if two words share a ≥4-char prefix (loose stemming for inflections). */
function sharePrefix(a: string, b: string): boolean {
	const n = Math.min(a.length, b.length);
	if (n < 4) return false;
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return i >= 4;
}

/**
 * Answer a natural-language question by traversing the graph from the
 * best-matching seed nodes. BFS gives broad neighborhood context (default);
 * DFS traces a specific path. Returns ranked hits — the caller narrates them.
 * ponytail: lexical seed match, no embeddings. Upgrade path: rank seeds with a
 * real similarity model if recall proves weak.
 */
export function query(graph: GraphData, question: string, options: QueryOptions = {}): QueryHit[] {
	const { mode = "bfs", maxDepth = 2, limit = 25 } = options;
	const terms = tokenize(question);
	if (terms.length === 0) return [];

	const seeds = graph.nodes
		.map((node) => ({ node, score: seedScore(node, terms) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
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
