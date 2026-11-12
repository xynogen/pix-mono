---
name: pix-edit
description: How to use `edit` without retries — hash anchors from a fresh `read`, one non-overlapping batch per file, and the exact-text fallback. Use before multi-hunk edits, after an edit failed or applied only partly, or when a file may have changed.
disable-model-invocation: true
---
# edit — hash-anchor edits

`edit` was the second most error-prone tool in history (898 errors in 11,315 calls). Nearly all came from four causes below.

## Formats

Hash anchors (preferred), from the `LINE#HASH` prefixes that `read` returns:

```json
{ "path": "src/a.ts", "edits": [
  { "op": "replace", "pos": "12#A1F", "end": "14#C03", "lines": ["new line 12", "new line 13"] },
  { "op": "insert_after", "pos": "40#9B2", "lines": ["added"] }
] }
```

- `op`: `replace`, `insert_before`, or `insert_after`. `end` is for `replace` only.
- `lines` holds raw source lines: no `LINE#HASH|` prefix and no newline characters. An empty array deletes.

Exact text (fallback only after a hash edit fails): `{ "oldText": "...", "newText": "..." }`. `oldText` must match exactly once.

## Avoid the four common failures

| Error in history | Count | Fix |
|---|---|---|
| "Edit without read" | 293 | `read` the region in this session before editing it. |
| "target not found" / stale anchor | 77+ | The file changed. Use the "Current anchors" from the last edit result, or `read` again. Never guess a hash. |
| "PARTIAL APPLY" | 100+ | Edits in one call must not overlap and must all target the original file. Split dependent changes into separate calls. |
| schema: `edits.N` must be object / additional properties / `op` | 59 | Never mix hash and exact-text items in one call. Do not add fields such as `text` or `content`. |

## Pattern

1. `read` the lines you will change (use `offset`/`limit`, or `ast` `outline` then `symbol` for code).
2. Put every independent change to that file in one `edit` call.
3. Use the "Current anchors" in the result for the next edit to the same region.
4. Read the "LSP after edit" note. Fix new errors before moving on.

## Do not

- Use `sed -i`, `perl -pi`, or a heredoc in `bash` to change files.
- Use `write` to change a few lines of an existing file. `write` is for new files and complete rewrites.
- Retry the same failed edit unchanged. Read the error, then fix the anchor or the format.
