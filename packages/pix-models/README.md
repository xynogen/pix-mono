# pix-models

Pi extension — enhanced `/model` picker with coding score/rank.

## What it does

Takes over Pi's built-in `/model` command with a richer TUI picker. `/model <term>` opens it pre-filtered.

- **Each row** — model id, context window, per-M-token cost, and a coding score/rank (star bar) when available.
- **Sorting** — by coding score (best first), then alphabetically for unscored models. Fuzzy search filters as you type.
- **Thinking level** — left/right cycles `off` → `minimal` → `low` → `medium` → `high` → `xhigh`, shown live in the header.
- **Select** — switches the active model for the session.
- **Per-project prefs** — every model / thinking change is saved with `defaultProvider`, `defaultModel`, `defaultThinkingLevel` in one file: `<project>/.pi/settings.json` for trusted projects (created on first change), otherwise `~/.pi/agent/settings.json`. Pi merges the project file over the user file, so other projects fall back to user defaults. Each save shows a short notice with the target file.

Model metadata comes from `~/.cache/pi/` via `pix-data`; the coding score/rank is computed locally from the modelgrep catalog (best = #1).

## Install

```bash
pi install npm:@xynogen/pix-models
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
