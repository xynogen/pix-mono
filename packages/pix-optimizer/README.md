<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-optimizer

Token-optimization suite for Pi Coding Agent. Three tools wired into one
extension via `src/index.ts`, fronted by one **Optimizer** tab in `/pix` and one
shared status-bar cell:

- **Caveman** (`Cv`) — terse-output system prompt
- **RTK** (`Rk`) — prefixes shell commands with `rtk` + injects RTK prompt
- **Ponytail** (`Pt`) — lazy-senior-dev system prompt (minimal code, YAGNI)

TOON guidance lives exclusively in the on-demand `toon-json` skill bundled by
`@xynogen/pix-skills`; it is no longer optimizer state or prompt injection.

## Settings tab

The **Optimizer** tab of `/pix` opens an interactive overlay that fronts every tool:

```text
/pix optimizer             → open the overlay (←→ cycle value, ↑↓ move, esc close)
```

There is no separate `/optimizer` command and no text-arg form: the overlay is the only UI. Selecting a value calls
the tool's `run()` handler, which persists the new value and repaints the
shared status cell. Headless/test fallbacks print a plain status summary.

State (caveman/rtk/ponytail) persists in the `optimizer` section of `~/.pi/agent/pix.json`. That section is the only place it is stored; the old `optimizer.json` file is imported once by pix-runtime and never written again.

## Status bar

A single cell always shows all three tool icons in a fixed order, color-coded by
state: **accent** when the tool is enabled, **muted** when disabled.

### Icon style (Nerd Font, Unicode, or ASCII)

The default glyphs (Nerd Font PUA codepoints) are **Nerd Font** symbols and require a patched
font (e.g. MesloLGS NF). Terminals without one render them as missing-glyph
“tofu” boxes. Two font-independent fallbacks are available:

| Mode | Glyphs | Needs Nerd Font? |
|---|---|---|
| `nerd` (default) | Nerd Font PUA glyphs | yes |
| `unicode` | `♤ ♡ ♧` (outline card suits) | no |
| `ascii` | `Cv Rk Pt` | no |

Icons follow the **global** `pix-pretty` mode. Set it via `/pix` or the
`PRETTY_ICONS` environment variable; the optimizer has no separate icon toggle.

## Features

### Caveman Mode (`Cv`)

Makes replies follow [ASD-STE100 Simplified Technical English](https://asd-ste100.org).
Two layers: Layer 1 sets the words and sentences, Layer 2 sets the reply shape
(next action first, numbered steps, no preamble or closer). Both govern prose
only, not code or command syntax. Keeps the article, unlike the old
article-dropping caveman prompt.

| Level | Description                       |
|-------|-----------------------------------|
| lite  | STE-flavored words, light shape   |
| full  | STE words + full reply shape      |
| ultra | Strict STE + full reply shape     |
| micro | Experimental prompt-minimized     |

The Optimizer tab opens a settings dialog when needed. Default level
for new sessions is restored from `pix.json` → `optimizer`.

### RTK Tool Rewriting (`Rk`)

Two layers, both active automatically:

1. **Prompt layer** — injects the RTK system prompt (tells the model to
   prefix commands with `rtk`).
2. **Execute layer** — rewrites `bash` tool calls, prefixing known commands
   (`git`, `gh`, `cargo`, `npm`, `pnpm`, `docker`, `kubectl`, `ls`, `grep`, …)
   with `rtk` when the model forgets. **Command chains are split on `&&`,
   `||` and `;`, and every known segment is prefixed** — e.g.
   `git add . && git push` becomes `rtk git add . && rtk git push`.
   A segment whose output is piped (`a | b`) is left as is, and a command
   with any redirect (`<`, `>`) is not rewritten, so piped and redirected
   output stays intact. Operators inside quotes are ignored, and unparseable commands are left
   untouched. Commands are never rewritten while `rtk` is missing.

**Binary:** pix finds `rtk` in this order: `binary.json` → `~/.pi/agent/bin` →
PATH (see pix-runtime, Binaries).

When RTK is on and `rtk` is missing, pix downloads the latest official
release from `rtk-ai/rtk` into `~/.pi/agent/bin` the first time Pi loads. It
verifies the download against the release's `checksums.txt`.

The download is visible: a footer status while it runs, then one line naming
the version and source. It never blocks startup or a tool call.

The download is skipped when:

- `PI_OFFLINE` is set;
- RTK is off in the Optimizer tab;
- `binary.json` names a path that doesn't exist.

If you pin a path in `binary.json`, rewritten commands use that quoted path
instead of a bare `rtk`.

### Ponytail Mode (`Pt`)

"Lazy senior dev" mode. Governs **what** the agent builds (minimal code,
YAGNI), orthogonal to Caveman which governs **how** it talks — they pair. Before
writing code the agent stops at the first rung that holds: does this need to
exist → stdlib → native platform → installed dep → one line → minimum that
works. Validation, error handling, security, and accessibility are never cut.

| Level | Description                          |
|-------|--------------------------------------|
| lite  | Name the lazier alternative, you pick |
| full  | The ladder enforced (default)        |
| ultra | YAGNI extremist                      |

**No install required** — pure prompt injection, with no external binary or
PATH dependency.

## Configuration via `pix.json`

Optimizer state lives in `~/.pi/agent/pix.json`. You can edit it by hand, or use the Optimizer tab of `/pix`, which writes to the same section.

```jsonc
{
  "optimizer": {
    "caveman": "off",    // off | lite | full | ultra | micro
    "rtk":     "on",     // off | on
    "ponytail": "off"   // off | lite | full | ultra
  }
}
```

## Architecture

| File              | Role                                                      |
|-------------------|-----------------------------------------------------------|
| `src/index.ts`    | Wires the three tools + shared status and the Optimizer tab |
| `src/opt.ts`      | The Optimizer tab overlay in `/pix` (keyboard nav + cycling) |
| `src/mode.ts`     | Shared level/prompt/persistence plumbing for caveman and ponytail |
| `src/status.ts`   | Shared status-bar cell (`toolIcon()` → shared `pix-pretty` catalog) |
| `src/caveman.ts`  | Caveman logic, levels, prompt                            |
| `src/rtk.ts`      | RTK prompt + bash command rewriting                       |
| `src/ponytail.ts` | Ponytail logic, levels, prompt                            |
| `src/persist.ts`  | Reads/writes the `optimizer` section of `pix.json` via pix-runtime |
| `src/tool-result-filter.ts` | Strips model-guidance warnings from tool_result |

Each tool registers its own lifecycle hooks and exposes an `OptimizerHandle`
that the Optimizer tab dispatches to. All three share one `OptimizerStatus`.

## Development

```bash
bun run test
```

## Origin

This package was built by merging two upstream Pi community packages:

- **Caveman mode** — merged from `npm:pi-caveman`. Reimplemented here with
  multiple compression levels and integration with the shared Optimizer
  settings tab.

- **RTK rewriting** — merged from `npm:pi-rtk-optimizer`. Reimplemented here
  with a two-layer approach: prompt injection + live bash command rewriting
  that handles chained commands (`&&`, `||`, `;`, `|`).

- **Ponytail mode** — ruleset adapted from [`git:github.com/DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail),
  the "lazy senior dev" skill. Reimplemented here as a native optimizer
  tool with three intensity levels — no external hooks or files. The
  ruleset (the YAGNI ladder + safety carve-outs) is rewritten as a system-prompt fragment.

All upstreams are MIT licensed. No codebase was copied directly — the logic was
rewritten and combined into a single extension with a unified Optimizer
settings tab and shared status bar. This package does not sync back to any upstream.

## Install

```bash
pi install npm:@xynogen/pix-optimizer
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

MIT. See [LICENSE](LICENSE).
