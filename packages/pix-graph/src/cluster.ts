import type { GraphData, GraphNode } from "./analyzer.js";

/** Community id -> member node ids (0 = largest, deterministic). */
export type Communities = Map<number, string[]>;

const MAX_COMMUNITY_FRACTION = 0.25; // split communities larger than 25% of the graph
const MIN_SPLIT_SIZE = 10;

function byText(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}

/** Undirected adjacency with edge weights (parallel edges accumulate). */
function adjacency(graph: GraphData): Map<string, Map<string, number>> {
	const adj = new Map<string, Map<string, number>>();
	for (const node of graph.nodes) adj.set(node.id, new Map<string, number>());
	for (const link of graph.links) {
		if (link.source === link.target) continue;
		const a = adj.get(link.source);
		const b = adj.get(link.target);
		if (!a || !b) continue;
		const w = typeof link.weight === "number" ? link.weight : 1;
		a.set(link.target, (a.get(link.target) ?? 0) + w);
		b.set(link.source, (b.get(link.source) ?? 0) + w);
	}
	return adj;
}

/**
 * Louvain modularity maximization on a node subset.
 * ponytail: Louvain, not Leiden — Leiden needs the native graspologic lib.
 * Upgrade path: add a Leiden refinement pass over these communities.
 */
function louvain(nodeIds: string[], adj: Map<string, Map<string, number>>): string[][] {
	if (nodeIds.length === 0) return [];
	const inSet = new Set(nodeIds);
	// Weighted degree and total edge weight (m) over the subset.
	const degree = new Map<string, number>();
	let m2 = 0; // 2m
	for (const id of nodeIds) {
		let d = 0;
		for (const [nbr, w] of adj.get(id) ?? []) if (inSet.has(nbr)) d += w;
		degree.set(id, d);
		m2 += d;
	}
	if (m2 === 0) return nodeIds.map((id) => [id]).sort();

	const community = new Map<string, number>();
	nodeIds.forEach((id, i) => {
		community.set(id, i);
	});
	const comWeight = new Map<number, number>(); // sum of degrees in community
	for (const id of nodeIds) comWeight.set(community.get(id) as number, degree.get(id) ?? 0);

	let improved = true;
	let guard = 0;
	while (improved && guard < 100) {
		improved = false;
		guard += 1;
		for (const id of nodeIds) {
			const own = community.get(id) as number;
			const ki = degree.get(id) ?? 0;
			// Weight from id into each neighboring community.
			const toCom = new Map<number, number>();
			for (const [nbr, w] of adj.get(id) ?? []) {
				if (!inSet.has(nbr) || nbr === id) continue;
				const c = community.get(nbr) as number;
				toCom.set(c, (toCom.get(c) ?? 0) + w);
			}
			// Remove id from its community.
			comWeight.set(own, (comWeight.get(own) ?? 0) - ki);
			let best = own;
			let bestGain = 0;
			for (const [c, wIntoC] of toCom) {
				const gain = wIntoC - ((comWeight.get(c) ?? 0) * ki) / m2;
				if (gain > bestGain) {
					bestGain = gain;
					best = c;
				}
			}
			// Staying (own) baseline gain is 0 after removal; only move on positive gain.
			community.set(id, best);
			comWeight.set(best, (comWeight.get(best) ?? 0) + ki);
			if (best !== own) improved = true;
		}
	}

	const groups = new Map<number, string[]>();
	for (const id of nodeIds) {
		const c = community.get(id) as number;
		groups.set(c, [...(groups.get(c) ?? []), id]);
	}
	return [...groups.values()];
}

/**
 * Community detection with oversized-community splitting.
 * Isolates (degree 0) each become their own community. Communities larger than
 * 25% of the graph (min 10 nodes) get a second Louvain pass. Result is indexed
 * by size descending so id 0 is always the largest — stable across runs.
 */
export function cluster(graph: GraphData): Communities {
	if (graph.nodes.length === 0) return new Map();
	const adj = adjacency(graph);
	if (graph.links.length === 0) {
		const sorted = [...graph.nodes].sort((a, b) => byText(a.id, b.id));
		return new Map(sorted.map((n, i) => [i, [n.id]]));
	}

	const isolates: string[] = [];
	const connected: string[] = [];
	for (const node of graph.nodes) {
		if ((adj.get(node.id)?.size ?? 0) === 0) isolates.push(node.id);
		else connected.push(node.id);
	}

	const raw = [...louvain(connected, adj), ...isolates.map((id) => [id])];

	const maxSize = Math.max(MIN_SPLIT_SIZE, Math.floor(graph.nodes.length * MAX_COMMUNITY_FRACTION));
	const final: string[][] = [];
	for (const members of raw) {
		if (members.length > maxSize) {
			const parts = louvain(members, adj);
			if (parts.length <= 1) final.push(members);
			else final.push(...parts);
		} else {
			final.push(members);
		}
	}

	final.sort((a, b) => b.length - a.length || byText(a[0] ?? "", b[0] ?? ""));
	return new Map(final.map((members, i) => [i, [...members].sort(byText)]));
}

/** Ratio of actual intra-community edges to the maximum possible. */
export function cohesionScore(graph: GraphData, members: string[]): number {
	const n = members.length;
	if (n <= 1) return 1;
	const set = new Set(members);
	let actual = 0;
	for (const link of graph.links) {
		if (link.source !== link.target && set.has(link.source) && set.has(link.target)) actual += 1;
	}
	const possible = (n * (n - 1)) / 2;
	return possible > 0 ? Math.round((actual / possible) * 100) / 100 : 0;
}

/** Cohesion score per community. */
export function scoreAll(graph: GraphData, communities: Communities): Map<number, number> {
	return new Map([...communities].map(([id, members]) => [id, cohesionScore(graph, members)]));
}

/** Stamp each node with its resolved community id (mutates a clone-safe copy). */
export function assignCommunities(nodes: GraphNode[], communities: Communities): void {
	const byNode = new Map<string, number>();
	for (const [id, members] of communities) for (const m of members) byNode.set(m, id);
	for (const node of nodes) {
		const c = byNode.get(node.id);
		if (c !== undefined) node.community = c;
	}
}
