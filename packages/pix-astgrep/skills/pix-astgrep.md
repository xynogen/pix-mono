---
name: pix-astgrep
description: How to use the `ast` tool — outline a file, read one symbol instead of the whole file, and search or rewrite code by AST pattern with a safe preview. Use before reading large source files, renaming a call pattern across files, or finding every call of a function shape.
disable-model-invocation: true
---
# ast — syntax-aware code read, search and rewrite

One tool, six actions. Syntax only: no type information (use `lsp` for that).

| Action | Fields | Use for |
|---|---|---|
| `outline` | `path` (file or dir) | top-level declarations with line numbers |
| `symbol` | `path`, `symbol` | exact source of one declaration |
| `enclosing` | `path`, `line` | smallest declaration around a line (stack traces, diagnostics) |
| `search` | `pattern`, `paths?`, `lang?`, `limit?` | structural matches, e.g. `fetch($URL, $$$)` |
| `replace` | `pattern`, `rewrite`, `paths?`, `lang?`, `apply?` | AST rewrite; preview unless `apply: true` |
| `symbols` | `query`, `paths?`, `limit?` | files ranked by identifier hits (AND-matched) |

## Read code with fewer tokens

1. `outline` the file.
2. `symbol` the one function you need, or `enclosing` for a line from an error.
3. `read` with `offset`/`limit` only for the lines between symbols.

A whole `read` of a 300+ line source file is the most common waste. The nudge points here for that reason.

## Patterns

- `$NAME` matches one node; `$$$ARGS` matches zero or more.
- A pattern must parse as code in that language. `foo($A)` is valid; `foo(` is not.
- When a fragment does not parse alone, pass `pattern: { context, selector }`. Example for PHP: `context: "<?php 123;"`, `selector: "integer"`.
- Set `lang` when the file extension is ambiguous or missing.

## Rewrite safely

1. `replace` without `apply` and read the line diff.
2. Narrow `paths` or the pattern until the preview shows only the intended edits.
3. Run it again with `apply: true`.
4. Check the result with `lsp` (`action: "diagnostics"`).

## Do not

- Use `search` for plain text, comments, or config. Use `grep`.
- Use `symbols` for exact references. It ranks by name hits; use `lsp` `navigate` `references`.
- Approve an unexpected grammar download. The consent prompt means a new language; newly installed grammars may need an agent restart.
