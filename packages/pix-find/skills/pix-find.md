---
name: pix-find
description: How to use `find` — glob matching of file paths, one call for several patterns, limit handling, and why it is not a content search. Use to locate files by name or extension instead of `find`, `fd`, or `ls -R` in bash.
disable-model-invocation: true
---
# find — glob file search

## Input

`{ "pattern": "**/*.ts", "path": ".", "limit": 200, "patterns": ["*.json", "*.yaml"] }`.

- `pattern` is a glob on the path, not a regex on content.
- Default 200 paths; `limit` raises that and the result says when the limit was reached, so an incomplete list is visible.
- `patterns` searches several known globs in one call, each capped, one combined result.
- Respects `.gitignore` and stays under the 50KB hard limit.

## Output

Dim preview of matched relative paths; cut previews fade at the bottom (`… N more lines (ctrl+o to expand)`) — presentation only. The call label shows the glob and search directory.

## Do not

- Use `find`, `fd`, or `ls -R` in `bash`.
- Use `find` to search file contents. Use `grep`.
- Run one `find` per pattern. Use `patterns`.
- Hunt a file by name in a language you can filter: `find` then `grep` on the candidates, and `read` only the winner.
