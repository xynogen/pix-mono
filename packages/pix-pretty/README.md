<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-pretty

Rendering and formatting library for Pi Coding Agent with syntax highlighting, file icons, tree views, FFF search integration, and gate-dialog overlay.

## What it does

This package is a **library + a small extension** that other pix packages
consume. It does not register user-facing tools itself — the tool renderers
(`pix-read`, `pix-bash`, `pix-ls`, `pix-find`, `pix-grep`, `pix-edit`,
`pix-write`) import from it. The extension entry point (`src/index.ts`) only
keeps above-editor widgets in a stable order (TUI sessions), clears the highlight
cache, seeds the icon mode from `pix.json`, and registers two FFF slash
commands (`/fff-health`, `/fff-rescan`) once `pix-grep` has brought the FFF
finder online. The `/pix` settings command lives in `pix-runtime`.
(Activated by `pix-core`; not a standalone extension.)

### Rendering

- **Syntax highlighting** — `cli-highlight` (highlight.js-backed)
- **File icons** — type-aware icons in ls/find output
- **Tree views** — hierarchical directory display for ls
- **Diff rendering** — side-by-side split diff for edit/write
- **Bash exit summary** — colored status, line count, truncation notice
- **Truncated previews** — a cut preview fades out bottom-up (`./text`:
  `fadeRowsOf`) and ends with one muted footer, `… N more lines (ctrl+o to expand)`
  (`./utils`: `moreLines`, `expandHint`). The hint shows the user's own expand
  key through Pi's `keyHint`. Expanded views show every row.

### Icon catalog (l10n-style)

Icons are treated like a localization catalog: packages never hardcode glyph
codepoints — they ask for a **semantic role** and the catalog resolves it
against one global icon mode. Reskinning, or fixing a missing-glyph (“tofu”)
problem on terminals without a Nerd Font, becomes a one-file edit here.

- **`./icon-catalog`** — `icon(key)` resolves a semantic key (`"cwd"`,
  `"model"`, `"paste.image"`, `"opt.caveman"`, …) to a glyph for the active
  mode. Modes: `nerd` (Nerd Font PUA, default), `unicode` (standard BMP glyphs,
  no patched font needed), `ascii` (plain letters). Also `iconFor(key, mode)`,
  `getIconMode()`, `setIconMode()`, `ICON_KEYS`, `ICON_MODES`.
- **`./icon-persist`** — reads/writes the icon mode via `pix.json`
  (`pretty.icons`); `initIconMode()` applies it on load.
- **`/pix`** (in `pix-runtime`) — unified settings overlay that includes the icon
  mode switch. One global knob governs every pix-* package (footer, paste
  chips, model picker, welcome banner, optimizer cell). Seeded from
  `PRETTY_ICONS` (`none`/`off` → `ascii`) when no choice is saved.

### Shared overlay

- **Gate overlay** (`./gate-overlay`) — the one permission-dialog component
  shared by `pix-gate` and `pix-sudo`. Two modes: `confirm` (SelectList) and
  `sudo` (SelectList + masked password). Returns
  `{ action: "approved" | "denied" | "timeout", password? }`. Padded with
  `Box` `paddingX=2`, `paddingY=1`. The simpler `./confirm` export is the
  plain boolean Yes/No dialog.
- **Provider picker** (`./provider-picker`) — the color-coded settings UI
  shared by `/web` and `/voice`: a sectioned settings overview, and a provider
  tree with a default dot, connection status, and expandable shell variables
  with set state and an export example.

### Inline chips (`./chips`)

The one source of truth for inline chip tags. Producers build tags with `chipTag`:
`chipTag.path(p)` (`@` picker), `chipTag.skill(ref)` (`$` picker), `chipTag.prompt(name, body)` (`/plan`).
The model receives each tag verbatim. `registerChips(pi)` shows them as chips in the prompt
editor and in sent user messages. `pix-display` calls it. Add a new chip kind here, not in a feature package.

UI features that moved to [`pix-display`](https://www.npmjs.com/package/@xynogen/pix-display): reasoning-tag (`<think>`/`<thinking>`) → native
`thinking` content blocks.

## Configuration

Configuration is read from **`~/.pi/agent/pix.json`** (the unified config file owned by `@xynogen/pix-runtime/config`). The `pretty` section of that file sets the defaults for theme, icon mode, and preview lines. Environment variables still override `pix.json` values.

> **Note:** config and collapse helpers previously shipped with `pix-pretty`; they now live in `pix-runtime` (`@xynogen/pix-runtime/config` and `@xynogen/pix-runtime/collapse`). Update any direct imports.

### `pix.json` — `pretty` section

```jsonc
{
  "pretty": {
    "icons": "nerd",          // nerd | unicode | ascii
    "lsStyle": "grid",        // grid | tree (pix-ls layout)
    "maxPreviewLines": 80,
    "maxRenderLines": 150,
    "maxRenderWidth": "65%",  // modal frame width; percentage or columns
    "maxRenderHeight": "80%", // pagination threshold; percentage or rows
    "maxHighlightChars": 80000,
    "cacheLimit": 128,
    "diff": {
      "splitMinWidth": 150,
      "splitMinCodeWidth": 60
    }
  }
}
```

Syntax highlighting, diffs, and tool surfaces use the active Pi theme. Color overrides do not live in `pix.json`. `/pix` exposes modal width and height under **Pretty**; percentage choices move in 5% steps.

### Environment Variables (override `pix.json`)

- `PRETTY_MAX_HL_CHARS` — max characters to highlight (default: 80000)
- `PRETTY_MAX_HL_LINE_CHARS` — max characters per line to highlight (default: 2000; env only)
- `PRETTY_MAX_PREVIEW_LINES` — max lines in preview output
- `PRETTY_CACHE_LIMIT` — FFF cache size limit
- `PRETTY_ICONS` — default icon mode when none is persisted: `nerd` (default),
  `unicode`, `ascii`, or `none`/`off` (→ `ascii`).
  Note: this seeds the file-icon helpers AND the semantic icon catalog.
  Overridden by the `/pix` settings command.
- `PRETTY_MAX_RENDER_LINES` — max lines in edit/write diff render (default: 150)
- `PRETTY_FFF_DIR` — override FFF state dir (default: `~/.cache/pi/fff`)

## Public exports

The package exposes its sub-modules via `exports`:

```
@xynogen/pix-pretty            (default — extension entry)
@xynogen/pix-pretty/ansi
@xynogen/pix-pretty/batch        (multi-target `paths` helpers and section caps)
@xynogen/pix-pretty/confirm
@xynogen/pix-pretty/progress
@xynogen/pix-pretty/config
@xynogen/pix-pretty/diff
@xynogen/pix-pretty/diff-render
@xynogen/pix-pretty/highlight
@xynogen/pix-pretty/lang
@xynogen/pix-pretty/icons
@xynogen/pix-pretty/icon-catalog
@xynogen/pix-pretty/icon-persist
@xynogen/pix-pretty/renderers
@xynogen/pix-pretty/fff
@xynogen/pix-pretty/types
@xynogen/pix-pretty/utils
@xynogen/pix-pretty/text         (text fade helpers for previews and widgets)
@xynogen/pix-pretty/widget-format
@xynogen/pix-pretty/resize
@xynogen/pix-pretty/context
@xynogen/pix-pretty/gate-overlay
@xynogen/pix-pretty/modal-frame
@xynogen/pix-pretty/provider-picker
@xynogen/pix-pretty/shell-tool   (shared bash/powershell tool registrar + renderer)
@xynogen/pix-pretty/command-preview
@xynogen/pix-pretty/tool-status  (binary download status + missing-binary warnings)
@xynogen/pix-pretty/test-utils   (renderer test helpers)
@xynogen/pix-pretty/transient-error
@xynogen/pix-pretty/grammar-consent
@xynogen/pix-pretty/chips        (inline chip tags + editor/history chip renderer)
```

## Install

```bash
pi install npm:@xynogen/pix-pretty
```

> Foundation library. Feature packages install it as a dependency. Install it directly only when you build your own extension on it.

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

MIT. See [LICENSE](LICENSE).
