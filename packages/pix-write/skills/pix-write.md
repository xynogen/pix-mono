---
name: pix-write
description: How to use `write` — full-file creation or complete rewrite, with a split diff when an existing file is replaced. Use for new files and whole-file rewrites only; use `edit` for changing part of an existing file.
disable-model-invocation: true
---
# write — create or replace a whole file

## Input

`{ "path": "...", "content": "..." }`. `content` is the complete file, including its final newline. Parent directories are created when missing.

## Choose write vs edit

| Situation | Tool |
|---|---|
| New file | `write` |
| Complete rewrite (generated file, restructured module) | `write` |
| Change a few lines of an existing file | `edit` |

Replacing an existing file renders a side-by-side diff of old vs new with line numbers and a change summary. New files render a syntax-highlighted preview. Both collapse to a one-line status row after the collapse delay.

## Before writing

- `read` the existing file first when you intend to replace it. `write` does not merge: anything you leave out of `content` is deleted.
- Proofread the anchors or line numbers you are about to drop. A truncated `content` destroys the file's tail with no warning.

## Do not

- Use `write` to change a few lines. Rewriting a 500-line file to alter one line hides the real change in the diff.
- Use `echo >` or a heredoc in `bash` to create a file.
