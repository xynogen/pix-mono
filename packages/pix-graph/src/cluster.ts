import type { GraphData, GraphNode } from "./analyzer.ts";

/** Community id -> member node ids (0 = largest, deterministic). */
export type Communities = Map<number, string[]>;

const MAX_COMMUNITY_FRACTION = 0.25; // split communities larger than 25% of the graph
const MIN_SPLIT_SIZE = 10;

function byText(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}

/** Ownership edges: hierarchy, not dependency. They never feed clustering. */
const HIERARCHY = new Set(["contains"]);

/** Each node's owner: the source of its `contains` edge, or itself. */
function owners(graph: GraphData): Map<string, string> {
	const owner = new Map(graph.nodes.map((n) => [n.id, n.id]));
	for (const link of graph.links) {
		if (HIERARCHY.has(link.relation) && owner.has(link.target) && owner.has(link.source)) {
			owner.set(link.target, link.source);
		}
	}
	return owner;
}

/**
 * Undirected weighted adjacency of the dependency projection: every non-hierarchy
 * edge is lifted onto its endpoints' owners (entity -> file), parallel edges accumulate.
 */
function adjacency(graph: GraphData, owner: Map<string, string>): Map<string, Map<string, number>> {
	const adj = new Map<string, Map<string, number>>();
	for (const id of new Set(owner.values())) adj.set(id, new Map<string, number>());
	for (const link of graph.links) {
		if (HIERARCHY.has(link.relation)) continue;
		const s = owner.get(link.source);
		const t = owner.get(link.target);
		if (!s || !t || s === t) continue;
		const a = adj.get(s);
		const b = adj.get(t);
		if (!a || !b) continue;
		const w = typeof link.weight === "number" ? link.weight : 1;
		a.set(t, (a.get(t) ?? 0) + w);
		b.set(s, (b.get(s) ?? 0) + w);
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
 * Community detection over the dependency projection, with oversized-community splitting.
 * Files (owners) are clustered on imports/calls; every owned entity joins its owner's
 * community, so ownership never glues groups together. Isolated owners each become their
 * own community. Communities larger than 25% of the graph (min 10 owners) get a second
 * Louvain pass. Result is indexed by size descending so id 0 is always the largest.
 */
export function cluster(graph: GraphData): Communities {
	if (graph.nodes.length === 0) return new Map();
	const owner = owners(graph);
	const adj = adjacency(graph, owner);

	const isolates: string[] = [];
	const connected: string[] = [];
	for (const id of [...adj.keys()].sort(byText)) {
		if ((adj.get(id)?.size ?? 0) === 0) isolates.push(id);
		else connected.push(id);
	}

	const raw = [...louvain(connected, adj), ...isolates.map((id) => [id])];

	const maxSize = Math.max(MIN_SPLIT_SIZE, Math.floor(adj.size * MAX_COMMUNITY_FRACTION));
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

	// Expand owners to every node they own.
	const owned = new Map<string, string[]>();
	for (const [id, o] of owner) owned.set(o, [...(owned.get(o) ?? []), id]);
	const expanded = final.map((members) => members.flatMap((m) => owned.get(m) ?? [m]));
	expanded.sort(
		(a, b) => b.length - a.length || byText(a.sort(byText)[0] ?? "", b.sort(byText)[0] ?? ""),
	);
	return new Map(expanded.map((members, i) => [i, [...members].sort(byText)]));
}

/**
 * Deterministic community names: dominant package (or folder) plus the most-connected
 * entity, e.g. `@xynogen/pix-graph · extract()`. Reads `node.community` stamps.
 */
export function communityLabels(graph: GraphData): Map<number, string> {
	const degree = new Map<string, number>();
	for (const l of graph.links) {
		if (HIERARCHY.has(l.relation)) continue;
		degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
		degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
	}
	const groups = new Map<number, GraphNode[]>();
	for (const n of graph.nodes) {
		if (n.community === undefined) continue;
		groups.set(n.community, [...(groups.get(n.community) ?? []), n]);
	}
	const labels = new Map<number, string>();
	for (const [id, members] of groups) {
		const counts = new Map<string, number>();
		for (const n of members) {
			const file = n.source_file ?? "";
			const where =
				typeof n.package === "string" ? n.package : file.split("/").slice(-3, -1).join("/") || file;
			if (where) counts.set(where, (counts.get(where) ?? 0) + 1);
		}
		const place = [...counts].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))[0]?.[0];
		const hub = [...members].sort(
			(a, b) =>
				// Entities carry a source_location; file nodes do not. Name the group after an entity.
				Number(!a.source_location) - Number(!b.source_location) ||
				(degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
				byText(a.id, b.id),
		)[0];
		labels.set(id, [place, hub?.label].filter(Boolean).join(" · ") || `Community ${id}`);
	}
	return labels;
}

/** Ratio of actual intra-community edges to the maximum possible. */
export function cohesionScore(graph: GraphData, members: string[]): number {
	const set = new Set(members);
	const n = set.size;
	if (n <= 1) return 1;
	// Count each unordered pair once: parallel edges (calls + imports, a→b + b→a) must not push the score above 1.
	const pairs = new Set<string>();
	for (const { source, target } of graph.links) {
		if (source === target || !set.has(source) || !set.has(target)) continue;
		pairs.add(source < target ? `${source}\0${target}` : `${target}\0${source}`);
	}
	const actual = pairs.size;
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
