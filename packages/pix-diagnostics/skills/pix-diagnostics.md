---
name: pix-diagnostics
description: How to use the `lsp` tool — fresh diagnostics after edits, exact navigation (definition, references, callers, hover, rename preview), and session-only diagnostic marks. Use when verifying edits, tracing a symbol, or triaging type and lint errors.
disable-model-invocation: true
---
# lsp — diagnostics and exact navigation

One tool, three actions. It talks to the project's language server (setup: the `lsp` skill).

| Action | Fields | Returns |
|---|---|---|
| `diagnostics` | `source` (`lsp`\|`session`), `paths?`, `severity?`, `waitMs?` | findings per file |
| `navigate` | `operation`, `path?`, `line?`, `character?` or `symbol?`, `query?`, `newName?`, `direction?`, `limit?` | locations, hover text, symbols |
| `mark` | `op` (`set`\|`list`\|`clear`), `path?`, `code?`, `disposition?`, `note?` | session-only marks; files never change |

## After an edit

- Edits and writes already append an "LSP after edit" report. Read it before the next change.
- For a fresh check, call `diagnostics` with `source: "lsp"` and the changed `paths`. `session` only reads the cache.
- "unconfirmed" means the server did not answer in time. Retry once with a larger `waitMs` before reading it as clean.

## Navigate a known symbol

- `definition`, `typeDefinition`, `implementation`: where it is declared.
- `references`: every usage. Prefer it over `grep` for identifiers.
- `callHierarchy` with `direction: "incoming"` (callers) or `"outgoing"` (callees).
- `hover`: the type at a position.
- `documentSymbol` (one file), `workspaceSymbol` with `query` (whole project).
- `rename` with `newName`: a preview of the edits only. Apply them with `edit`.

Positions are one-based. Give `line` plus either `character` or `symbol` (the identifier on that line).

## Marks

Use `mark` `set` for a known false positive or a deferred finding, so later reports stay readable. Always add a `note` with the reason. Marks last for this session only.

## Do not

- Treat "unavailable" as clean. No server is configured for that language; load the `lsp` skill to set one up.
- Run `diagnostics` on the whole tree. Pass the files you changed.
