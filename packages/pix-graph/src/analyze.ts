import type { GraphData, GraphNode } from "./analyzer.js";
import type { Communities } from "./cluster.js";

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

const CODE_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);
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
	const ext = label.split(".").at(-1) ?? "";
	if (CODE_EXT.has(ext)) return true; // filename label
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
		if (topDir(uf) !== topDir(vf)) {
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
