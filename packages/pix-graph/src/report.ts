import type { GodNode, Surprise } from "./analyze.js";
import type { GraphData } from "./analyzer.js";
import type { Communities } from "./cluster.js";

/** Inputs for the human-readable graph report. */
export interface ReportInput {
	graph: GraphData;
	communities: Communities;
	cohesion: Map<number, number>;
	gods: GodNode[];
	surprises: Surprise[];
	labels?: Map<number, string>;
}

function nodeLabel(graph: GraphData, id: string): string {
	return graph.nodes.find((n) => n.id === id)?.label ?? id;
}

/** Render GRAPH_REPORT.md — communities, god nodes, surprising connections. */
export function renderGraphReport(input: ReportInput): string {
	const { graph, communities, cohesion, gods, surprises, labels } = input;
	const lines: string[] = [
		"# Graph Report",
		"",
		`- Nodes: ${graph.nodes.length}`,
		`- Links: ${graph.links.length}`,
		`- Communities: ${communities.size}`,
		"",
		"## Communities",
		"",
	];
	if (communities.size === 0) lines.push("None.", "");
	else {
		for (const [id, members] of communities) {
			const name = labels?.get(id) ?? `Community ${id}`;
			const score = cohesion.get(id) ?? 0;
			lines.push(`- **${name}** (${members.length} nodes, cohesion ${score})`);
		}
		lines.push("");
	}

	lines.push("## God Nodes", "");
	if (gods.length === 0) lines.push("None.", "");
	else {
		for (const g of gods) lines.push(`- \`${g.label}\` — ${g.edges} edges`);
		lines.push("");
	}

	lines.push("## Surprising Connections", "");
	if (surprises.length === 0) lines.push("None.", "");
	else {
		for (const s of surprises) {
			const from = nodeLabel(graph, s.source);
			const to = nodeLabel(graph, s.target);
			lines.push(`- \`${from}\` ${s.relation} \`${to}\` — ${s.why.join("; ")}`);
		}
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}
