---
name: pix-read
description: How to use `read` efficiently — syntax-highlighted text or attached images, `LINE#HASH` anchors that feed `edit`, offset/limit for large files, and one batch call for several known paths. Use before reading source, after `grep` or `ast` points at a file, and before any edit.
disable-model-invocation: true
---
# read — file content as edit anchors

Text comes back as `LINE#HASH|source`, not raw text. The `LINE#HASH` prefix is a valid `edit` anchor, so a read that covers the region you will change is all the setup an edit needs.

## Input

`{ "path": "...", "offset": 1, "limit": 400 }`.

- Text defaults to 400 lines, capped at 2,000 lines / 50KB including anchors. `offset`/`limit` pick the window; `limit` may not exceed the cap.
- For several known files, pass `paths` to read them in one call. Each file is capped and the combined result stays under the 50KB limit.
- Images are attached, not printed: MIME type and byte size appear in the result.

## Pattern

1. Locate the region cheaply: `grep` for the identifier, or `ast` `outline` then `symbol` for a big code file.
2. `read` with `offset`/`limit` around that region.
3. Edit with the anchors from this read. Never guess a hash; anchors go stale the moment the file changes.

## Rendering

Long content shows a bounded preview whose last rows fade out, ending with `… N more lines (total) (ctrl+o to expand)`. This is presentation only: the full text was already returned to the model. Do not re-`read` the same range to "see the rest".

## Do not

- Use `cat`, `head`, `tail`, or `sed -n` in `bash` to read files.
- Read a whole 5,000-line file to change three lines: `grep` first, then `offset`/`limit`.
