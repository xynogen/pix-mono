---
name: graph
description: "Use for any question about a TS/JS codebase — its architecture, what calls what, how a feature works, or tracing data flow. Prefer this over grepping when a graph exists. Builds and queries a native knowledge graph via the `graph` tool (mode:build / mode:query) or the pix-graph CLI. No Python, no external service."
disable-model-invocation: true
---

# graph

`@xynogen/pix-graph` turns a TS/JS codebase into a queryable knowledge graph:
files and symbols become nodes, `imports`/`contains`/`calls` become edges,
Louvain finds communities, and you traverse the result instead of grepping.

Two ways to drive it — a **model-callable tool** (preferred inside Pi) and a
**CLI** (scripts, CI, or when the tool isn't loaded). Both read and write the
same `.pi/pix-graph/graph.json`.

## The `graph` tool (preferred)

One tool, two modes:

```
graph(mode:"build")                          # build/update the graph for the whole repo
graph(mode:"build", path:"packages/foo")     # scope the scan to a subtree
graph(mode:"query", question:"how does auth work")        # BFS — broad neighborhood
graph(mode:"query", question:"trace build → write", dfs:true)   # DFS — follow one path
```

- **build** extracts + clusters and writes `.pi/pix-graph/{graph.json, graph.cleaned.json, GRAPH_REPORT.md}`. A live progress widget streams scan → parse → cluster → analyze → write. Re-run after edits to refresh (this is the "update" path).
- **query** loads the existing graph and returns a ranked tree of matching nodes with the relation each was reached by. Add `dfs:true` to trace a single path instead of fanning out.

## When to use it

- Any "how does X work / what calls Y / where is Z / trace the flow" question about the code → `graph(mode:"query", …)` **before** reading files. The graph already maps the call structure.
- After you change code and expect to query again → `graph(mode:"build")` to refresh.
- `pix-nudge` reminds you automatically when `.pi/pix-graph/graph.json` exists.

## Fast path — a graph already exists

If `.pi/pix-graph/graph.json` (or a legacy `graphify-out/graph.json`) is present
and the request is a natural-language question about the codebase, go straight
to `graph(mode:"query", question)`. Do not rebuild first unless the code changed
materially since the last build.

## CLI (outside Pi, or when the tool isn't loaded)

```bash
bun packages/pix-graph/src/cli.ts build [path]                  # → .pi/pix-graph/
bun packages/pix-graph/src/cli.ts query "<question>" [--dfs] [--depth N]
bun packages/pix-graph/src/cli.ts path "<from>" "<to>"          # shortest path between two nodes
# from the repo root you can also use:  bun run graph:build
```

`--graph <file>` points query/path at a specific graph (default
`.pi/pix-graph/graph.cleaned.json`, falling back to `graph.json`).

## Outputs

| File | Contents |
|---|---|
| `.pi/pix-graph/graph.json` | Full graph — nodes, links, community assignments |
| `.pi/pix-graph/graph.cleaned.json` | Same, with false inferred `calls` edges removed (validated against real TS bindings) |
| `.pi/pix-graph/GRAPH_REPORT.md` | Communities, god nodes (most-connected abstractions), surprising cross-file connections |

The `.pi/` directory is gitignored, so the graph never gets committed.

## Interpreting a query result

- **Depth 0 rows are seeds** — the nodes that matched your question directly.
- **Indented rows are neighbors**, tagged with the relation used to reach them
  (`contains`, `calls`, `imports`). `contains` = a file/symbol declared inside;
  `calls` = an inferred cross-file call; `imports` = an import edge.
- A node's `source_file` tells you exactly where to open next.
- Inferred `calls` edges are best-effort. If a result looks wrong, prefer the
  cleaned graph (query loads it by default) or confirm by reading the file.

## Scope and limits

- **TS/JS only.** Other languages aren't parsed yet (no tree-sitter extractor).
- **Louvain clustering**, not Leiden — communities are good, not maximally refined.
- **Lexical seed matching**, no embeddings — queries lean on keyword overlap with
  symbol names and paths. Use concrete identifiers when recall matters.
- **Code only.** For docs, PDFs, images, or video, use the external
  [graphify](https://github.com/safishamsi/graphify) project instead; its JSON
  schema is compatible, so a graph built there also answers `graph(mode:"query")`.
