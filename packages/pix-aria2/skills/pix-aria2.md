---
name: pix-aria2
description: How to use `download` — fast resumable multi-connection transfers with a live progress widget, the add/list/pause/resume/rm actions and `dl-*` handles. Use for large files, models, archives, and any transfer worth resuming, instead of curl/wget in bash.
disable-model-invocation: true
---
# download — resumable transfers

Backed by a managed aria2 daemon. Multi-connection and resumable by default.

## Input

`{ "action": "add", "url": "...", "dir": "..." }`

| Action | Needs | Result |
|---|---|---|
| `add` | `url` (http(s), ftp, magnet) | a `dl-*` handle |
| `list` | — | active downloads with progress |
| `pause` / `resume` / `rm` | `handle` | updated job state |

- `dir` defaults to the current directory.
- Keep the handle: every later action targets it by `dl-*` name.

## Pattern

1. `add` the URL, note the handle.
2. Do not poll with `bash sleep`. The progress widget is live; read `list` when you actually need a status.
3. `pause` instead of `rm` when the transfer may continue; `rm` drops the job.

## Do not

- Use `curl -o` or `wget` for a large or resumable transfer.
- Re-`add` the same URL to resume it. `resume` the existing handle.
- Delete a job that is still wanted just because `list` shows no progress yet.
