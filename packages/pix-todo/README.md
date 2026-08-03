# pix-todo

Pi tool — durable execution checklist (`todo`).

## What it does

Registers the `todo` tool, which gives the agent a persistent task checklist that survives context compaction and session restore. The checklist is seeded by the model via the `set` action and tracks items through four statuses: `pending` (○), `in_progress` (◐), `done` (●), and `blocked` (⊘). State is persisted via Pi's `appendEntry("todo-state")` so the agent can recover its position after long runs or compaction events. The agent calls `todo(action:"list")` to resume where it left off. Actions: `list`, `set`, `add`, `update`, `clear`.

Every 10 turns, if any item is still `pending` or `in_progress`, the current checklist summary is injected into the system prompt so the model stays aware of unfinished work and can't skip incomplete items.

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

> Also included in [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core):
>
> ```bash
> pi install npm:@xynogen/pix-core
> ```

## Full distro

Source: [github.com/xynogen/pix-mono](https://github.com/xynogen/pix-mono)

To install the complete pix suite (all packages + Pi itself):

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

## License

MIT
