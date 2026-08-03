# pix-edit

Pi tool — precise text replacement edit with diff rendering.

## What it does

Replaces Pi's default `edit` tool with an enhanced version that renders a side-by-side split diff after every edit. The diff is syntax-highlighted with gutter markers, line numbers, and a change summary produced by `pix-pretty`'s diff engine. Batched edits (multiple `{oldText, newText}` pairs in one call) each render their own diff block. Call labels show the target file path and the number of edits being applied. Depends on `@xynogen/pix-pretty`, installed automatically as a dependency.

## Auto-collapse

After a configurable delay (default 10 seconds), a completed diff collapses to a one-line status row. Structured failures use a compact `✗` row after the delay. Expanding restores the existing bounded diff or exact diagnostic without restarting the elapsed timer. This is controlled via the `collapse` section of `~/.pi/agent/pix.json`:

```jsonc
{
  "collapse": {
    "enabled": true,
    "delaySec": 10,
    "tools": { "edit": true }
  }
}
```

Set `collapse.tools.edit: false` to disable for this tool only. See `@xynogen/pix-runtime/collapse` for the full API.

## Install

```bash
pi install npm:@xynogen/pix-edit
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
