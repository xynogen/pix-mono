# pix-toolbox

Pi tool — gated tool toggle UI (`/toolbox`).

## What it does

Registers a `/toolbox` slash command — a TUI fuzzy-search picker listing every registered tool (built-in, extension, MCP), split into **Tools** and **MCP** tabs. Each tool has one of three states:

| State | Mark | Meaning |
|---|---|---|
| enabled | `✓` | Declared in the system prompt. |
| deferred | `~` | Not declared. `tool_search` loads it on demand. Only for tools with `deferred` exposure. |
| disabled | `#` | Not declared, and every call is blocked, also through `tool_search` or `codemode`. |

Keys: `tab` switch tab · `↑↓` navigate · `ctrl+e` enable · `ctrl+f` defer · `ctrl+d` disable · `space` cycle · any other key types into the search.

- Four tools (`bash`, `edit`, `read`, `write`) are protected and stay enabled.
- State persists to `~/.pi/agent/pix.json` under `toolbox`. Only changes from the default are saved: `disabledTools` (tools you disabled) and `loadedTools` (deferred tools you enabled). A newly installed tool keeps its default. A legacy `enabledTools` file is migrated on the next session start.
- Headless subcommands: `/toolbox enable|defer|disable <names>`, `/toolbox list [query]`.

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
