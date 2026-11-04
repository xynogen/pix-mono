<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-powershell

Pi tool — PowerShell execution with pretty output.

## What it does

Renders Pi's built-in `powershell` tool the same way [`pix-bash`](https://www.npmjs.com/package/@xynogen/pix-bash) renders `bash`: a compact call line, a full-width status-colored framed output block, a live five-line tail while the command runs, and an auto-collapsed one-line summary such as `✓ powershell Get-ChildItem -Force · 42 lines · 1.2s`. Long output fades out bottom-up and ends with a footer such as `… 12 more lines (ctrl+o to expand)`, with your own expand key. Execution is unchanged — it wraps Pi's own `createPowerShellToolDefinition` (`pwsh.exe`, falling back to Windows PowerShell).

## Output and compatibility fixes

- **Plain-text output.** PowerShell 7.2+ adds ANSI colour to table headers and errors even when output is piped, which wastes tokens and clutters the transcript. Every command starts with `if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }`. Windows PowerShell 5.1 has no `$PSStyle`, so the line is a no-op there.
- **`&&` / `||` on Windows PowerShell 5.1.** Pi falls back to `powershell.exe` when `pwsh.exe` isn't on PATH, and 5.1 rejects chain operators. On 5.1 only, top-level chains are rewritten to `$?` checks (`a && b` → `a; $__pixOk = $?; if ($__pixOk) { b; … }`), and a failed chain at the end of the script still exits non-zero. Operators inside strings, comments, here-strings, and `( [ {` blocks are left alone. Whenever a rewrite happens, the output starts with a visible `[pix-powershell] … rewrote && / ||` line.

## Windows only

Pi exposes `powershell` only on native Windows. pix-powershell follows that:

- On non-Windows platforms it registers nothing, so no extra tool schema reaches the model.
- On native Windows it registers the `powershell` tool at load time, so the tool is enabled automatically. Inside pix-core it stays always on (never deferred), like the default shell. `bash` stays enabled too.

## Auto-collapse

Uses the shared `collapse` section of `~/.pi/agent/pix.json`. Disable for this tool only with:

```jsonc
{ "collapse": { "tools": { "powershell": false } } }
```

## Install

```bash
pi install npm:@xynogen/pix-powershell
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
