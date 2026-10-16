---
name: search
description: Maps where a behavior lives and how it connects across a codebase — finds every match, groups by role, and traces the call chain with file:line evidence. Use when the user asks "where is X", "find all usages of Y", "how is Z wired up", "what handles this", or when a behavior's location is unknown across many files.
disable-model-invocation: true
---
# Search

Goal: the full map, not the first match.

## Tools

- **Unknown location, text, config, comments** → the `grep` and `find` tools, then `read` the hits.
- **Known symbol** → `lsp_navigation` with `definition`, `references`, `implementation`, `callHierarchy`, or `hover`. LSP results are exact; prefer them over grep for symbols.
- **Code graph available** (`.pi/graph/graph.json`) → `graph` query first.

Start broad with grep, then switch to LSP for exact navigation.

## Steps

1. **Sweep** — Search the term plus synonyms, abbreviations, and other spellings (`retry`, `backoff`, `attempts`). Use one wide pattern rather than many narrow ones.
2. **Group** — Sort hits by role: logic, config, tests, docs.
3. **Trace** — From the entry point, follow the calls to the exit. Note each call site and cross-module dependency.
4. **Stop** when a new search finds no new locations. Cap the report at about 20 locations and say how many more exist.

## Report

```
## Target: [what you searched]
Terms tried: [list]

## Found in
- Logic: `path:line` — [role]
- Config: `path:line` — [role]
- Tests: `path:line` — [role]

## How it connects
[entry] → `path:line` → `path:line` → [exit]

## Notes
[Surprises only: dead paths, missing tests, conflicting copies.]
```

No match → say so and list the terms you tried.
