<!-- markdownlint-disable MD013 -->

<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-display

Pi core extension — inline chips, thinking blocks, and framed code snippets.

## What it does

Four features, always on when installed:

**Inline chips.** Renders `<path>…</path>` spans (written by e.g. `pix-search`) as `@name` chips, `<skill>…</skill>` spans (written by the `pix-skills` `$` picker) as `$name` chips with the skills.sh `owner/repo` in dim, and replaces Pi's paste markers (`[paste #1 2232 chars]`) with styled icon chips: `image #1` for image pastes (blue), `text N chars` / `text Nk chars` for text pastes over 100 characters (green). A shorter paste stays inline, even with many lines. Collapses pasted image paths into markers in the buffer while showing human-readable labels on screen. The display rewrite is purely visual — the buffer keeps the real path for the model. Expansion wraps each paste in `<paste>…</paste>` so adjacent pastes don't merge into one wall in the model-facing text. Sent user messages get the same treatment in the transcript (display-only, via Pi's Markdown transformer hook, Pi ≥ 0.85): `<paste>`/`<path>`/`<skill>` spans collapse to inline chips, text pastes keep a head…tail glimpse. The chip code lives in `@xynogen/pix-pretty/chips`. pix-display only calls `registerChips(pi)`.

**Thinking blocks.** Converts leaked reasoning tags (`<think>`/`<thinking>`) from some providers into native Pi `thinking` content blocks, which render dim + italic via the `thinkingText` theme token. No ANSI injection, no markdown blockquote shim. Applies during streaming (`message_update`) and finalization (`message_end`).

**Code snippets.** Renders every fenced code block in assistant responses inside a themed, language-labeled frame, including Python, TypeScript, JSON, YAML, Rust, Go, SQL, shell, and arbitrary custom language tags. Untagged fences use a `code` label. Pi's native syntax highlighting remains intact for recognized languages, while long lines clip to the terminal width.

**Working timer.** While the agent runs, the TUI working message shows the elapsed time, for example `Working (12s)`. It clears when the agent stops.

The features are registered at session start. TUI-only display changes are no-ops in JSON/RPC/print modes. In-process non-TUI child sessions (such as background subagents) do not clear the parent TUI's renderer state.

## Install

```bash
pi install npm:@xynogen/pix-display
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
