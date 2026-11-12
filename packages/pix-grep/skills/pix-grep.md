---
name: pix-grep
description: How to use `grep` — regex or literal content search, batching several patterns, the `path:LINE#HASH|text` rows that feed `edit`, and what to do when the result says more matches exist. Use before reading files, instead of `rg`/`grep` in bash.
disable-model-invocation: true
---
# grep — content search

## Input

`{ "pattern": "regex", "path": ".", "glob": "*.ts", "ignoreCase": false, "literal": false, "context": 0, "limit": 30 }`.

- `pattern` is a regex unless `literal: true`. Escape regex metacharacters for a literal search.
- Default 30 matches. Use `limit` for more, or narrow `path`/`glob` first.
- `patterns` searches several known patterns in one call, each capped, one combined result.
- `ignoreCase` and any `path`/`glob` constraint bypass the frecency index and use ripgrep directly: same matches, no ranking.

## Rows are edit anchors

Match rows are `path:LINE#HASH|text`. `LINE#HASH` is a valid `edit` anchor, so `grep` → `edit` needs no `read` in between. Files over the anchor size limit keep plain `path:LINE:` rows; there, `read` the region before editing.

## When the result says more matches exist

It asks for a narrower pattern, path, or glob and carries a `cursor`. Narrow first. Use the `cursor` only when every match is genuinely needed, and do not loop over cursors to dump a repository.

## Do not

- Use `rg` or `grep` in `bash` to search files.
- Search a bare common word across the whole repo, then read every hit. Add `glob`, `path`, or `literal`.
- Re-grep a file you already grepped to find line numbers — the rows already carry line numbers and anchors.
