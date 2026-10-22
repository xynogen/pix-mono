# pix-graph

Native-TS code knowledge graph — extract, cluster, analyze, and query a codebase
without Python or an external service. TS/JS is parsed with the TypeScript
compiler API into a graph of files and symbols. Imports resolve to real files
(relative paths and workspace packages through `package.json` exports), and
`calls` edges follow import bindings and re-exports. Communities are found with
Louvain over file-level dependencies; questions are answered by BFS/DFS traversal
over the graph, or by ranking whole modules for architecture questions.

Ships three ways: a model-callable **`graph` tool**, a **CLI**, and a **library**.
Standalone/opt-in — not bundled by pix-core, so the one recurring tool schema is
only present when you install it.

## `graph` tool

One tool, three actions:

| Call | Effect |
|---|---|
| `graph(action:"build", path?)` | (Re)build/update the graph from source into `.pi/graph/`. Run again after edits to refresh. |
| `graph(action:"query", question, dfs?)` | Lexical search: match keywords against symbol/file names, then traverse. BFS (default) for broad context, `dfs:true` to trace a path. |
| `graph(action:"query", question, scope:"global")` | Rank whole modules (workspace packages) for architecture questions. Returns each module's summary and evidence card. |
| `graph(action:"summarize")` | List up to 5 modules whose summary is missing or stale, with their evidence cards and a token estimate. |
| `graph(action:"summarize", module, summary)` | Store a summary written by the agent. It must cite the module's card. |

Summaries live in `.pi/graph/summaries.json`, keyed by module, evidence hash, model,
and prompt version. The tool never calls a model itself: the session model writes each
summary, and the result shows which model did it. An unchanged rebuild leaves every
summary current, so a repeat run has no work.

`pix-nudge` also drops a one-line reminder to prefer `graph(action:"query")` over
grepping when `.pi/graph/graph.json` exists (it also detects a legacy
`graphify-out/graph.json`). Output lives under the gitignored `.pi/` dir.

## CLI

```bash
pix-graph build [path] [--out DIR] [--root DIR]   # extract + cluster + analyze
pix-graph query "<question>" [--graph FILE] [--dfs] [--depth N]
pix-graph path "<from>" "<to>" [--graph FILE]      # shortest path between nodes
```

`build` writes into `--out` (default `.pi/graph/`):

| Output | Description |
|---|---|
| `graph.json` | Full graph: nodes (with `package`), links, community assignments |
| `graph.cleaned.json` | Graph that query reads, after validation; communities are computed on this graph |
| `GRAPH_REPORT.md` | Named communities, package boundaries (imports, calls, APIs, `file:line` sites), unresolved internal imports, god nodes, surprising connections |
| `graph.html` | Interactive view of `graph.cleaned.json`: community colors, search, node details. Open it with `/graph`. |

## Library

```ts
import { buildCodeGraph, query, analyzeGraph } from "@xynogen/pix-graph";

const result = buildCodeGraph("src", process.cwd(), ".pi/graph");
// → { nodes, links, communities, outputDir }
```

| Export | Purpose |
|---|---|
| `collectFiles`, `extract` | Walk a tree and parse TS/JS into `{ nodes, links, unresolved }` |
| `buildGraph`, `cluster`, `communityLabels`, `cohesionScore`, `scoreAll` | Assemble, Louvain community detection, deterministic names |
| `godNodes`, `surprisingConnections` | Graph analysis |
| `query`, `shortestPath` | Traversal over a built graph |
| `renderGraphReport`, `boundaries` | Human-readable report and package boundary cards |
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
- **Lexical query seeds, no embeddings.** Global scope gains meaning only from
  stored summaries. Upgrade path: BM25 or a similarity model if recall proves weak.
- **No tsconfig `paths` aliases.** Imports through them stay unresolved.
  Upgrade path: read `compilerOptions.paths` in `resolve.ts`.
- **Code only.** For docs, PDFs, images, or video, use external graphify.

## Install

```bash
pi install npm:@xynogen/pix-graph
```

> Standalone and opt-in. [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core) does not bundle it. You run it on demand. Its `graph` tool schema loads only when you install it.

## Full distro

This package is part of [Pix](https://github.com/xynogen/pix-mono). The installer sets up Pi and the full distro. See [Install](https://github.com/xynogen/pix-mono#install) for the notes for each OS.

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.ps1 | iex
```

## License

MIT
