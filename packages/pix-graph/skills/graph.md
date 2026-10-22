---
name: graph
description: "Use for any question about a TS/JS codebase — its architecture, what calls what, how a feature works, or tracing data flow. Prefer this over grepping when a graph exists. Builds, queries, and summarizes a native knowledge graph via the `graph` tool (build / query / summarize) or the pix-graph CLI. No Python, no external service."
disable-model-invocation: true
---

# graph

`@xynogen/pix-graph` turns a TS/JS codebase into a queryable knowledge graph:
files and symbols become nodes, `imports`/`contains`/`calls` become edges,
Louvain finds communities, and you traverse the result instead of grepping.
Imports resolve to real files, including workspace packages, so package boundaries
are visible.

Two ways to drive it — a **model-callable tool** (preferred inside Pi) and a
**CLI** (scripts, CI, or when the tool isn't loaded). Both read and write the
same `.pi/graph/graph.json`.

## The `graph` tool (preferred)

One tool, three actions:

```
graph(action:"build")                          # build/update the graph for the whole repo
graph(action:"build", path:"packages/foo")     # scope the scan to a subtree
graph(action:"query", question:"authenticate token")       # BFS — names, then neighbors
graph(action:"query", question:"buildGraph write", dfs:true)   # DFS — follow one path
graph(action:"query", question:"auth session", scope:"global")  # rank whole modules
graph(action:"summarize")                      # list modules that need a summary
graph(action:"summarize", module:"@x/auth", summary:"…")  # store one
```

- **build** extracts, cleans, and clusters, then writes `.pi/graph/{graph.json, graph.cleaned.json, GRAPH_REPORT.md, graph.html}`. A live progress widget streams scan → parse → analyze → cluster → write. Re-run after edits to refresh (this is the "update" path).
- **query** is lexical. Pass identifiers or name fragments, not prose. It returns a ranked tree of matching nodes with the relation each was reached by. Add `dfs:true` to trace a single path.
- **query `scope:"global"`** ranks modules (workspace packages) and returns each module's summary plus its evidence card: entry files, APIs other modules call, dependencies, and users.
- **summarize** with no arguments lists up to 5 modules whose summary is missing or stale, with their cards and a token estimate. With `module` + `summary`, it stores a summary written by you. Write 2-5 sentences grounded only in that card (purpose, entry points, key APIs, dependencies). The summary must name the module or something from its card, or it is rejected. Run it only when the user asks for summaries or a global answer needs them; it costs your tokens.

## When to use it

- "where is X / what calls Y / trace the flow" → `graph(action:"query", …)` **before** reading files.
- "what are the main parts / how do A and B interact" → `graph(action:"query", scope:"global", …)`, or read the **Package Boundaries** section of `GRAPH_REPORT.md`.
- After you change code and expect to query again → `graph(action:"build")` to refresh.
- `pix-nudge` reminds you automatically when `.pi/graph/graph.json` exists.

## Fast path — a graph already exists

If `.pi/graph/graph.json` (or a legacy `graphify-out/graph.json`) is present
and the request is a natural-language question about the codebase, go straight
to `graph(action:"query", question)`. Do not rebuild first unless the code changed
materially since the last build.

## CLI (outside Pi, or when the tool isn't loaded)

```bash
bun packages/pix-graph/src/cli.ts build [path]                  # → .pi/graph/
bun packages/pix-graph/src/cli.ts query "<question>" [--dfs] [--depth N]
bun packages/pix-graph/src/cli.ts path "<from>" "<to>"          # shortest path between two nodes
# from the repo root you can also use:  bun run graph:build
```

`--graph <file>` points query/path at a specific graph (default
`.pi/graph/graph.cleaned.json`, falling back to `graph.json`).

## Outputs

| File | Contents |
|---|---|
| `.pi/graph/graph.json` | Full graph — nodes (with `package`), links, community assignments |
| `.pi/graph/graph.cleaned.json` | Graph that query reads, after validation; communities are computed on it |
| `.pi/graph/GRAPH_REPORT.md` | Named communities, package boundaries with `file:line` evidence, unresolved internal imports, god nodes, surprising connections |
| `.pi/graph/graph.html` | Interactive view for the user. The user opens it with `/graph`. Do not read it into context. |
| `.pi/graph/summaries.json` | Module summaries with evidence hash, model, and prompt version |

The `.pi/` directory is gitignored, so the graph never gets committed.

## Interpreting a query result

- **Depth 0 rows are seeds** — the nodes that matched your question directly.
- **Indented rows are neighbors**, tagged with the relation used to reach them
  (`contains`, `calls`, `imports`). `contains` = a symbol declared in a file;
  `calls` = a call from a declaration to an imported symbol; `imports` = a file
  imports another file.
- A node's `source_file` tells you exactly where to open next.
- `calls` edges follow import bindings only. A call through a callback, a method
  on an object, or a tsconfig `paths` alias is not in the graph. Confirm by reading the file.

## Scope and limits

- **TS/JS are exact; other languages are coarse.** Python, Go, Rust, Java, C/C++, Ruby, … are parsed with ast-grep when `@xynogen/pix-astgrep` is installed. They get definitions and unambiguous cross-file `calls` (`INFERRED`), no import edges. The first build in a new language asks to install its grammar; the result lists skipped languages.
- **Louvain clustering**, not Leiden — communities are good, not maximally refined.
- **Lexical seed matching**, no embeddings — queries lean on keyword overlap with
  symbol names and paths. Use concrete identifiers when recall matters. Global
  scope gets its meaning from stored summaries.
- **Code only.** For docs, PDFs, images, or video, use the external
  [graphify](https://github.com/safishamsi/graphify) project instead; its JSON
  schema is compatible, so a graph built there also answers `graph(action:"query")`.
