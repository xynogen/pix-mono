<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-find

Pi tool — glob file search with FFF acceleration.

## What it does

Replaces Pi's default `find` tool with a version backed by `pix-pretty`. Uses FFF (frecency-ranked, SIMD-accelerated file finder) when available, falling back to the standard glob search. Returns up to 200 paths by default; `limit` asks for more. Pass `patterns` to search several globs in one call. Results are rendered as a dim preview of the matched relative paths; the call label shows the glob pattern and search directory inline. A cut preview fades out at the bottom and ends with `… N more lines (ctrl+o to expand)`. The finder is shared with `pix-grep` (owned there) — install `pix-grep` alongside to populate the index. Depends on `@xynogen/pix-pretty`, installed automatically as a dependency.

## Auto-collapse

After a configurable delay (default 10 seconds), completed output collapses to a row such as `✓ find **/*.ts · 24 files`. Structured failures use a compact `✗` row after the delay. Expanding restores the existing bounded result list or exact diagnostic without restarting the elapsed timer. This is controlled via the `collapse` section of `~/.pi/agent/pix.json`:

```jsonc
{
  "collapse": {
    "enabled": true,
    "delaySec": 10,
    "tools": { "find": true }
  }
}
```

Set `collapse.tools.find: false` to disable for this tool only. See `@xynogen/pix-runtime/collapse` for the full API.

## Install

```bash
pi install npm:@xynogen/pix-find
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
