<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-edit

Pi tool — precise text replacement edit with diff rendering.

## What it does

Replaces Pi's default `edit` tool with a version that renders a side-by-side split diff after every edit. The diff is syntax-highlighted with gutter markers, line numbers, and a change summary produced by `pix-pretty`'s diff engine. Batched edits (multiple operations in one call) each render their own diff block. Call labels show the target file path and the number of edits being applied. Depends on `@xynogen/pix-pretty`, installed automatically as a dependency.

- **Hash anchors first.** Each operation is `{op, pos, end?, lines}` with `op` as `replace`, `insert_before`, or `insert_after`. `pos`/`end` are `LINE#HASH` anchors from `read` or `grep`. Use exact text `{oldText, newText}` only after a hash-anchor edit fails. One call never mixes the two formats.
- **Fresh anchors.** A successful edit returns the current `LINE#HASH|text` rows around each changed span, so the next edit needs no new read.
- **Stale anchors.** A stale or out-of-bounds anchor fails with the current anchors near the target.
- **Short argument errors.** Invalid arguments fail with a short message that says how to fix them.

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
