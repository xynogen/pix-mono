import type { GraphData } from "./analyzer.js";
import { assignCommunities, type Communities, cluster, scoreAll } from "./cluster.js";
import type { Extraction } from "./extract.js";

/** Fully built graph plus its community structure. */
export interface BuiltGraph {
	graph: GraphData;
	communities: Communities;
	cohesion: Map<number, number>;
}

/** Assemble extraction into a clustered {@link GraphData} with community stamps. */
export function buildGraph(extraction: Extraction): BuiltGraph {
	const graph: GraphData = {
		directed: false,
		multigraph: false,
		nodes: extraction.nodes,
		links: extraction.links,
	};
	const communities = cluster(graph);
	assignCommunities(graph.nodes, communities);
	return { graph, communities, cohesion: scoreAll(graph, communities) };
}
