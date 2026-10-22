import type { GodNode, Surprise } from "./analyze.ts";
import type { GraphData, GraphNode } from "./analyzer.ts";
import type { Communities } from "./cluster.ts";
import type { UnresolvedImport } from "./extract.ts";

/** Inputs for the human-readable graph report. */
export interface ReportInput {
	graph: GraphData;
	communities: Communities;
	cohesion: Map<number, number>;
	gods: GodNode[];
	surprises: Surprise[];
	labels?: Map<number, string>;
	unresolved?: UnresolvedImport[];
}

/** One package-to-package dependency with its evidence. */
export interface Boundary {
	from: string;
	to: string;
	/** Distinct file→file import edges. */
	imports: number;
	/** Distinct caller→callee call edges. */
	calls: number;
	/** Imported entity labels, most-called first. */
	apis: string[];
	/** First `file:Lnn` evidence sites. */
	sites: string[];
}

const packageOf = (n: GraphNode): string | undefined =>
	typeof n.package === "string" ? n.package : undefined;

/**
 * Module-level dependency map ("boundary cards") from resolved imports and calls.
 * `moduleOf` groups nodes; the default groups by workspace package.
 */
export function boundaries(
	graph: GraphData,
	moduleOf: (n: GraphNode) => string | undefined = packageOf,
): Boundary[] {
	const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
	const cards = new Map<string, Boundary & { apiCount: Map<string, number> }>();
	for (const l of graph.links) {
		if (l.relation !== "imports" && l.relation !== "calls") continue;
		const s = byId.get(l.source);
		const t = byId.get(l.target);
		const from = s ? moduleOf(s) : undefined;
		const to = t ? moduleOf(t) : undefined;
		if (!t || !from || !to || from === to) continue;
		const key = `${from}\0${to}`;
		const card = cards.get(key) ?? {
			from,
			to,
			imports: 0,
			calls: 0,
			apis: [],
			sites: [],
			apiCount: new Map<string, number>(),
		};
		cards.set(key, card);
		if (l.relation === "imports") {
			card.imports++;
			if (card.sites.length < 3) card.sites.push(`${l.source_file}:${l.source_location}`);
		} else {
			card.calls++;
			card.apiCount.set(t.label, (card.apiCount.get(t.label) ?? 0) + 1);
		}
	}
	return [...cards.values()]
		.map(({ apiCount, ...card }) => ({
			...card,
			apis: [...apiCount]
				.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
				.map(([label]) => label),
		}))
		.sort(
			(a, b) =>
				b.imports + b.calls - (a.imports + a.calls) ||
				(`${a.from}${a.to}` < `${b.from}${b.to}` ? -1 : 1),
		);
}

function nodeLabel(graph: GraphData, id: string): string {
	return graph.nodes.find((n) => n.id === id)?.label ?? id;
}

/** Render GRAPH_REPORT.md — communities, god nodes, surprising connections. */
export function renderGraphReport(input: ReportInput): string {
	const { graph, communities, cohesion, gods, surprises, labels, unresolved = [] } = input;
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

	const cards = boundaries(graph);
	lines.push("## Package Boundaries", "");
	if (cards.length === 0) lines.push("None.", "");
	else {
		for (const c of cards) {
			const apis =
				c.apis.length > 0
					? ` — uses ${c.apis
							.slice(0, 6)
							.map((a) => `\`${a}\``)
							.join(", ")}`
					: "";
			lines.push(`- \`${c.from}\` → \`${c.to}\`: ${c.imports} imports, ${c.calls} calls${apis}`);
			if (c.sites.length > 0) lines.push(`  - at ${c.sites.join(", ")}`);
		}
		lines.push("");
	}

	lines.push("## Unresolved Internal Imports", "");
	if (unresolved.length === 0) lines.push("None.", "");
	else {
		for (const u of unresolved.slice(0, 50)) {
			lines.push(`- \`${u.specifier}\` at ${u.source_file}:${u.source_location}`);
		}
		if (unresolved.length > 50) lines.push(`- … ${unresolved.length - 50} more`);
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
