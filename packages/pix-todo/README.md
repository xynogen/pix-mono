<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-todo

Pi tool — durable execution checklist (`todo`).

## What it does

Registers the `todo` tool, which gives the agent a persistent task checklist that survives context compaction and session restore. The checklist is seeded by the model via the `set` action and tracks items through four statuses: `pending` (○), `in_progress` (◐), `done` (●), and `blocked` (⊘). State is persisted via Pi's `appendEntry("todo-state")` so the agent can recover its position after long runs or compaction events. The agent calls `todo(action:"list")` to resume where it left off. Actions: `list`, `set`, `add`, `update`, `clear`.

By default a list is an ordered run: opening or completing an item closes earlier ones and warns about skipped items. Pass `ordered: false` on `set` for independent items.

Every 10 user prompts, if any item is still `pending` or `in_progress`, a visible `pix-todo-reminder` message recites the open items, so the model keeps unfinished work in view. The system prompt is not rewritten, so the prompt cache stays valid.

Set `remind: true` to opt into visible continue reminders after each run while tasks remain (`remind: false` turns them off). Reminders stop on an interruption, an error, a blocked item, or 3 nudges without progress.

## Progress widget

While a checklist exists, a compact one-line widget above the editor shows the current item, its status, and the position (for example `2/5`) or the done count. Long item text fades out at the edge. The widget clears after the collapse delay once every item is `done`.

## Auto-collapse

The checklist card uses the shared `@xynogen/pix-runtime/collapse` state machine and auto-collapses after a configurable delay (default 10 seconds) to a row such as `✓ todo #2 release prep · 1/2 done`. Expanding an elapsed card restores the immutable checklist snapshot for that result, with its colored status glyphs, without restarting the timer. Failed actions keep their exact diagnostic instead of rendering a checklist. The delay and per-tool toggle are read from `~/.pi/agent/pix.json`:

```jsonc
{
  "collapse": {
    "enabled": true,
    "delaySec": 10,
    "tools": { "todo": true }
  }
}
```

Set `collapse.tools.todo: false` to keep the checklist always expanded. See `@xynogen/pix-runtime/collapse` for the full API.

## Install

```bash
pi install npm:@xynogen/pix-todo
```

> Bundled in [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core). Install it alone only if you do not use pix-core.

## Full distro

This package is part of [Pix](https://github.com/xynogen/pix-mono). The installer sets up Pi and the full distro. See [Install](https://github.com/xynogen/pix-mono#install) for the notes for each OS.

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.ps1 | iex
```

## License

MIT
