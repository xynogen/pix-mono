# pix-write

Pi tool — file write with diff rendering.

## What it does

Replaces Pi's default `write` tool with an enhanced version that renders a side-by-side split diff when overwriting an existing file. New files are shown with a syntax-highlighted preview (capped by default; expand to see the full content). The diff uses `pix-pretty`'s diff engine: syntax-highlighted old/new panes with gutter markers, line numbers, and a change summary. Call labels show the target file path and write mode (`create` for new files, `write` for overwrites). Depends on `@xynogen/pix-pretty`, installed automatically as a dependency.

## Auto-collapse

After a configurable delay (default 10 seconds), a completed write collapses to a one-line status row. Structured failures use a compact `✗` row after the delay. Expanding recomputes and restores the existing bounded preview or diff, or the exact diagnostic, without restarting the elapsed timer. This is controlled via the `collapse` section of `~/.pi/agent/pix.json`:

```jsonc
{
  "collapse": {
    "enabled": true,
    "delaySec": 10,
    "tools": { "write": true }
  }
}
```

Set `collapse.tools.write: false` to disable for this tool only. See `@xynogen/pix-runtime/collapse` for the full API.

## Install

```bash
pi install npm:@xynogen/pix-write
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
