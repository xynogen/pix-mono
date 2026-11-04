<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-bash

Pi tool — bash shell execution with pretty output.

## What it does

Replaces Pi's default `bash` tool with an enhanced version backed by `pix-pretty`. Output is rendered in a full-width framed block showing an exit-code summary, line count, and truncation notice. Call labels display the command inline; multi-line commands collapse to the first line with `… (+N lines)` until expanded. In expanded mode the full output is shown. Collapsed mode caps the preview at `pretty.maxPreviewLines` (default 80): the last rows fade out and a footer reads `… N more lines (ctrl+o to expand)`. Depends on `@xynogen/pix-pretty`, which is installed automatically as a dependency.

## Auto-collapse

After a configurable delay (default 10 seconds), completed output collapses to one line, for example `✓ bash bun test · exit 0 · 42 lines`. Structured failures remain readable until the same delay, then use a compact `✗` row. Expanding either row restores the normal output or exact diagnostic without restarting the elapsed timer. The delay and per-tool toggle are controlled via the `collapse` section of `~/.pi/agent/pix.json`:

```jsonc
{
  "collapse": {
    "enabled": true,
    "delaySec": 10,
    "tools": { "bash": true }
  }
}
```

Set `collapse.tools.bash: false` (or `collapse.enabled: false`) to disable. See `@xynogen/pix-runtime/collapse` for the full API.

## Install

```bash
pi install npm:@xynogen/pix-bash
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
