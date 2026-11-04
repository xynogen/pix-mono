<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-read

Pi tool — file read with syntax highlighting.

## What it does

Replaces Pi's default `read` tool with a version backed by `pix-pretty`. File content is syntax-highlighted using `cli-highlight` (highlight.js-backed) with language auto-detection. The call label shows the shortened file path, with optional `from line N` and `(N lines)` hints. Images show MIME type, byte size, and a type icon. A cut preview of a long file fades its last rows bottom-up and ends with a footer such as `… 120 more lines (180 total) (ctrl+o to expand)`; expanded mode reveals the full content. Depends on `@xynogen/pix-pretty`, installed automatically as a dependency.

## Auto-collapse

After a configurable delay (default 10 seconds), completed output collapses to a row such as `✓ read src/index.ts · 120 lines`. Structured failures use a compact `✗` row after the delay. Expanding recomputes and restores the normal bounded preview or exact diagnostic without restarting the elapsed timer. Configure this in the `collapse` section of `~/.pi/agent/pix.json`:

```jsonc
{
  "collapse": {
    "enabled": true,
    "delaySec": 10,
    "tools": { "read": true }
  }
}
```

Set `collapse.tools.read: false` to disable for this tool only. See `@xynogen/pix-runtime/collapse` for the full API.

## Install

```bash
pi install npm:@xynogen/pix-read
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
