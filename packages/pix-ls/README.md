# pix-ls

Pi tool — enhanced directory listing.

## What it does

Replaces Pi's default `ls` tool with an enhanced version backed by `pix-pretty`. Output is rendered with file/directory icons and a total entry-count header. Call labels show the target path inline. Depends on `@xynogen/pix-pretty`, installed automatically as a dependency.

## Display style

The listing layout is configurable via `pretty.lsStyle` in `~/.pi/agent/pix.json`:

| Value    | Description |
|----------|-------------|
| `"grid"` | Horizontal columns, like `eza`/`ls` (default) |
| `"tree"` | Vertical tree with `├──`/`└──` connectors |

```jsonc
{
  "pretty": {
    "lsStyle": "grid"   // or "tree"
  }
}
```

## Auto-collapse

After a configurable delay (default 10 seconds), completed output collapses to a row such as `✓ ls packages · 29 entries`. Structured failures use a compact `✗` row after the delay. Expanding restores the configured listing or exact diagnostic without restarting the elapsed timer. This is controlled via the `collapse` section of `~/.pi/agent/pix.json`:

```jsonc
{
  "collapse": {
    "enabled": true,
    "delaySec": 10,
    "tools": { "ls": true }
  }
}
```

Set `collapse.tools.ls: false` to disable for this tool only. See `@xynogen/pix-runtime/collapse` for the full API.

## Install

```bash
pi install npm:@xynogen/pix-ls
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
