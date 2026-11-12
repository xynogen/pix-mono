---
name: pix-ls
description: How to use `ls` — one batch call for several known directories, `limit` for more than 200 entries, and what the capped preview does and does not hide. Use to inspect a directory instead of `ls`, `tree`, or `find` in bash.
disable-model-invocation: true
---
# ls — directory listing

## Input

`{ "path": ".", "limit": 200, "paths": ["src", "tests"] }`.

- Defaults: 200 sorted entries, dotfiles included. `limit` raises that.
- `paths` lists up to 20 known directories in one call. Each directory is capped and the combined result stays under the 50KB hard limit.
- `path` and `paths` are alternatives: omit `path` when you pass `paths`.

## Output

Entries render with file/directory icons in a framed block showing the entry count. A long listing fades out at the bottom with `… N more entries (ctrl+o to expand)`: presentation only, the entries were already returned. Layout is `grid` (default) or `tree` per `pretty.lsStyle`.

## Do not

- Use `ls`, `tree`, or `find -type d` in `bash`.
- Call `ls` once per directory in a loop. Pass `paths` and batch it.
- Use `ls` to search. To match names, use `find`; to match contents, use `grep`.
