---
name: pix-hunk
description: How to drive a live Hunk diff review with the `hunk` tool — an ordered `ops` batch with actions list/get/context/review/navigate/comment/comment_list/comment_rm/highlight/highlight_clear/reload. Use when a Hunk review session is open and the user asks for a review, comments, or navigation.
disable-model-invocation: true
---
# hunk — scripted diff review

The user runs Hunk's interactive TUI in another terminal. This tool calls `hunk session *` only: it never launches `hunk diff`, `show`, `patch`, or another interactive command.

## Input

`{ "ops": [ ... ], "maxCharacters": 10000 }`. Every op has an `action`; ops run in order and every result is returned, so one call replaces a chain of shell commands.

```json
{ "ops": [
  { "action": "review" },
  { "action": "navigate", "file": "src/App.tsx", "hunk": 2 },
  { "action": "comment", "file": "src/App.tsx", "newLine": 42, "summary": "Handle the empty state" },
  { "action": "comment_list", "type": "user" }
] }
```

| Action | Key fields |
|---|---|
| `list`, `get`, `context`, `review` | `repo`, `sessionId`, `file`, `includePatch` |
| `navigate` | `file`, `hunk` (1-based), `newLine` / `oldLine` |
| `comment` | `file`, `newLine` or `oldLine`, `summary`, `rationale` |
| `comment_list` | `type`: `live`, `all`, `ai`, `agent`, `user` |
| `comment_rm` | `commentId` |
| `highlight` / `highlight_clear` | `start`, `end`, `tone`: `match`, `info`, `warning`, `error`, `current` |
| `reload` | `reloadArgs`, e.g. `["diff", "main...HEAD"]` |

`maxCharacters` (default 10,000) caps the model-facing result. Large patches are what blow it: request `context` around a line instead of the whole patch.

## Pattern

1. `list` to see the open review and its files.
2. `get`/`context` for the hunks you care about, not the entire diff.
3. Comment with a file line, not a raw offset. Line numbers are 1-based.
4. `comment_list type:"user"` before answering a review: the user's comments are the actual task.

## Do not

- Start or attach to a Hunk TUI yourself.
- Batch an op that depends on an earlier op's output without reading the first result.
