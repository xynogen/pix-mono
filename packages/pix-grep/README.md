<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-grep

Pi tool — pattern search in files with FFF acceleration.

## What it does

Replaces Pi's default `grep` tool with an enhanced version backed by `pix-pretty`.

- **FFF lifecycle** — owns the frecency-ranked, SIMD-accelerated file index: inits on `session_start`, tears down on `session_shutdown`.
- **Constrained searches** (`path`/`glob` set) skip FFF and use the SDK's ripgrep directly, avoiding a known FFF 0.5.2 abort on Unicode filenames. `ignoreCase` searches also use the SDK path, because FFF only has smart case. FFF searches are case-sensitive, like ripgrep. Falls back to plain ripgrep if `@ff-labs/fff-node` isn't installed.
- **Edit anchors** — match rows are `path:LINE#HASH|text`. `LINE#HASH` is a valid `edit` anchor. Files over the anchor size limit keep plain `path:LINE:` rows.
- **Batch** — returns up to 30 matches by default; `limit` asks for more. Pass `patterns` to search several patterns in one call.
- **Rendering** — match-count header, highlighted pattern, file paths + line numbers, dim inline preview. Call labels show pattern, path, glob. A cut preview fades out at the bottom and ends with `… N more lines (ctrl+o to expand)`.
- **Pagination** — when more matches exist than returned, the result asks for a narrower pattern, path, or glob first, and carries a `cursor` id that continues the search only if every match is needed.

## Auto-collapse

After a configurable delay (default 10 seconds), completed output collapses to a row such as `✓ grep tickCollapse · 12 matches`. Structured failures use a compact `✗` row after the delay. Expanding restores the existing bounded match preview or exact diagnostic without restarting the elapsed timer. This is controlled via the `collapse` section of `~/.pi/agent/pix.json`:

```jsonc
{
  "collapse": {
    "enabled": true,
    "delaySec": 10,
    "tools": { "grep": true }
  }
}
```

Set `collapse.tools.grep: false` to disable for this tool only. See `@xynogen/pix-runtime/collapse` for the full API.

## Install

```bash
pi install npm:@xynogen/pix-grep
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
