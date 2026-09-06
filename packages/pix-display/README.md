<!-- markdownlint-disable MD013 -->

# pix-display

Pi core extension — inline chips, thinking blocks, and polished code snippets.

## What it does

Three features, always on when installed:

**Inline chips.** Renders `<path>…</path>` spans (written by e.g. `pix-search`) as `@name` chips, and replaces Pi's paste markers (`[paste #1 2232 chars]`) with styled icon chips: `image #1` for image pastes (blue), `text +N lines` / `text Nk chars` for text pastes (green). Collapses pasted image paths into markers in the buffer while showing human-readable labels on screen. The display rewrite is purely visual — the buffer keeps the real path for the model. Expansion wraps each paste in `<paste>…</paste>` so adjacent pastes don't merge into one wall in the model-facing text. Sent user messages get the same treatment in the transcript (display-only, via Pi's Markdown transformer hook, Pi ≥ 0.85): `<paste>`/`<path>` spans collapse to inline chips, text pastes keep a head…tail glimpse.

**Thinking blocks.** Converts leaked reasoning tags (`<think>`/`<thinking>`) from some providers into native Pi `thinking` content blocks, which render dim + italic via the `thinkingText` theme token. No ANSI injection, no markdown blockquote shim. Applies during streaming (`message_update`) and finalization (`message_end`).

**Code snippets.** Renders every fenced code block in assistant responses inside a themed, language-labeled frame—including Python, TypeScript, JSON, YAML, Rust, Go, SQL, shell, and arbitrary custom language tags. Untagged fences use a `code` label. Pi's native syntax highlighting remains intact for recognized languages, while long lines are safely clipped to the terminal width.

The features are registered at session start. TUI-only display changes are no-ops in JSON/RPC/print modes. In-process non-TUI child sessions (such as background subagents) do not clear the parent TUI's renderer state.

## Install

```bash
pi install npm:@xynogen/pix-display
```

> Also included in [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core):
>
> ```bash
> pi install npm:@xynogen/pix-core
> ```

## Full distro

Source: [github.com/xynogen/pix-mono](https://github.com/xynogen/pix-mono)

To install the complete pix suite (all packages + Pi itself):

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

## License

MIT
