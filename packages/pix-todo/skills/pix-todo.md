---
name: pix-todo
description: How to use `todo` to track multi-step work across a long turn — set a plan, update statuses in one batched call, and keep it current through compaction. Use for a plan with several steps, not for a one-step task.
disable-model-invocation: true
---
# todo — durable task list

The list survives context compaction, so it is the record of what is left. The widget shows it beside the conversation.

## Input

`{ "action": "list" | "set" | "add" | "update" | "clear", ... }`

| Action | Fields |
|---|---|
| `list` | — |
| `set` | `items` (newline or numbered text), `ordered`, `remind` |
| `add` | `items` |
| `update` | `updates` (`"3:done,4:in_progress"`) or `id` + `status` + optional `text` |
| `clear` | — |

- Statuses: `pending`, `in_progress`, `done`, `blocked`.
- Prefer one `update` call with `updates` over one call per item.
- `ordered: true` (default on `set`) treats the list as sequential: opening or completing an item cascades to earlier ones and warns on skips. `ordered: false` for independent items.
- `remind: true` re-nudges while items stay unfinished.

## Pattern

1. `set` the plan once, at the start of multi-step work.
2. `update` the moment a step's state changes — do not batch status changes to the end.
3. `blocked` is information: state what blocks it rather than silently leaving it `in_progress`.
4. `clear` when the work is complete.

## Do not

- Write a todo for a single-step task.
- `set` the whole list again to change one item. That resets the plan and loses progress.
- Use `todo` as a notes file or a message to the user.
