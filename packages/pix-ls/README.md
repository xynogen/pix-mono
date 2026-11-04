<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-ls

Pi tool — enhanced directory listing.

## What it does

Replaces Pi's default `ls` tool with an enhanced version backed by `pix-pretty`. Output is rendered with file/directory icons in one status-colored framed block. The entry count shows in the collapsed row. Call labels show the target path inline. Depends on `@xynogen/pix-pretty`, installed automatically as a dependency.

- **Defaults** — 200 sorted entries, dotfiles included. Pass `limit` for more. Pi's 50KB hard limit still applies.
- **Batch** — pass `paths` to list up to 20 directories in one call. Each directory is capped, and the combined result stays under 50KB.
- **Previews** — a long listing shows the first 80 entries (`pretty.maxPreviewLines`), fades out bottom-up and ends with a footer such as `… 12 more entries (ctrl+o to expand)`. The footer shows your own expand key. The expanded view shows every entry.

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
