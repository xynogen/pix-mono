# @xynogen/pix-graph

Native-TS code knowledge graph — extract, cluster, analyze, and query a codebase
without Python or an external service. TS/JS is parsed with the TypeScript
compiler API into a graph of files and symbols; communities are found with
Louvain; questions are answered by BFS/DFS traversal over the graph.

Ships three ways: a model-callable **`graph` tool**, a **CLI**, and a **library**.
Standalone/opt-in — not bundled by pix-core, so the one recurring tool schema is
only present when you install it.

## `graph` tool

One tool, two modes:

| Call | Effect |
|---|---|
| `graph(action:"build", path?)` | (Re)build/update the graph from source into `.pi/pix-graph/`. Run again after edits to refresh. |
| `graph(action:"query", question, dfs?)` | Answer a codebase question by traversing the existing graph. BFS (default) for broad context, `dfs:true` to trace a path. |

`pix-nudge` also drops a one-line reminder to prefer `graph(action:"query")` over
grepping when `.pi/pix-graph/graph.json` exists (it also detects a legacy
`graphify-out/graph.json`). Output lives under the gitignored `.pi/` dir.

## CLI

```bash
pix-graph build [path] [--out DIR] [--root DIR]   # extract + cluster + analyze
pix-graph query "<question>" [--graph FILE] [--dfs] [--depth N]
pix-graph path "<from>" "<to>" [--graph FILE]      # shortest path between nodes
```

`build` writes into `--out` (default `.pi/pix-graph/`):

| Output | Description |
|---|---|
| `graph.json` | Full graph: nodes, links, community assignments |
| `graph.cleaned.json` | Inferred `calls` edges validated against real TS bindings; false ones removed |
| `GRAPH_REPORT.md` | Communities, god nodes, surprising cross-file connections |

## Library

```ts
import { buildCodeGraph, query, analyzeGraph } from "@xynogen/pix-graph";

const result = buildCodeGraph("src", process.cwd(), ".pi/pix-graph");
// → { nodes, links, communities, outputDir }
```

| Export | Purpose |
|---|---|
| `collectFiles`, `extract` | Walk a tree and parse TS/JS into `{ nodes, links }` |
| `buildGraph`, `cluster`, `cohesionScore`, `scoreAll` | Assemble + Louvain community detection |
| `godNodes`, `surprisingConnections` | Graph analysis |
| `query`, `shortestPath` | Traversal over a built graph |
| `renderGraphReport` | Human-readable report |
| `analyzeGraph`, `renderPatternReport` | Validate/clean an existing graph + extract repeated patterns |
| `buildCodeGraph` | Full pipeline orchestrator |

The graph JSON schema (nodes/links/hyperedges, `EXTRACTED`/`INFERRED` confidence)
is compatible with external [graphify](https://github.com/safishamsi/graphify) —
a graph built by either tool works with the other's `query`.

## Scope ceilings

- **TS/JS only.** Other languages need a tree-sitter extractor (not built).
  Upgrade path: add per-language extractors behind `collectFiles`.
- **Louvain, not Leiden.** Leiden needs the native `graspologic` library.
  Upgrade path: add a Leiden refinement pass over the Louvain communities.
- **Lexical query seeds, no embeddings.** Upgrade path: rank seed nodes with a
  similarity model if recall proves weak.
- **Code only.** For docs, PDFs, images, or video, use external graphify.

## Install

```bash
pi install npm:@xynogen/pix-graph
```

> Standalone/opt-in — **not** bundled by [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core). Install it directly if you want code-graph Q&A; the one recurring `graph` tool schema is only present when it's installed.

## Full distro

Source: [github.com/xynogen/pix-mono](https://github.com/xynogen/pix-mono)

To install the complete pix suite (all packages + Pi itself):

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

## License

MIT
