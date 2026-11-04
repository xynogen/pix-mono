<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-toolbox

Pi tool — gated tool toggle UI (`/pix tools`).

## What it does

Adds a **Tools** tab to `/pix` (`/pix tools` opens it directly) — a TUI fuzzy-search picker listing every registered tool (built-in, extension, MCP), split into **Tools** and **MCP** tabs. Each tool has one of three states:

| State | Mark | Meaning |
|---|---|---|
| enabled | `✓` | Declared in the system prompt. |
| deferred | `~` | Not declared. `tool_search` loads it on demand. Only for tools with `deferred` exposure. |
| disabled | `#` | Not declared, and every call is blocked, also through `tool_search` or `codemode`. |

Keys: `tab`/`shift+tab` switch tab · `↑↓` navigate · `←→`/`PgUp`/`PgDn` inspect · `ctrl+e` enable · `ctrl+f` defer · `ctrl+d` disable · `space` cycle · `esc` close · any other key types into the search.

- Rows are grouped: always-on tools first, then direct tools, then deferrable tools. Always-on tools (`read`, `bash`, `edit`, `write`, `tool_search`, `codemode`) are in every prompt. They are listed read-only and cannot be disabled or deferred. Direct tools can only be enabled or disabled.
- State persists to `~/.pi/agent/pix.json` under `toolbox`. Only changes from the default are saved: `disabledTools` (tools you disabled) and `loadedTools` (deferred tools you enabled). A newly installed tool keeps its default. A legacy `enabledTools` file is migrated on the next session start.

## Install

```bash
pi install npm:@xynogen/pix-toolbox
```

> Standalone and opt-in. [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core) does not bundle it. It is a power-user tool-toggle UI.

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
