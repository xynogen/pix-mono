<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-ask

Pi tool — structured questionnaire UI (`ask_user`).

## What it does

Registers the `ask_user` tool — up to 4 structured multiple-choice questions in a TUI dialog when the agent needs to resolve ambiguous requirements, instead of guessing.

- Each question: 2–4 options with labels + descriptions. Supports multi-select and markdown side-by-side previews.
- Every question appends a "Type something." free-form row, so the user can reject all options.
- **Multi-select** → also appends a "Confirm" row to commit the checked options.
- Non-interactive (RPC/JSON) mode falls back to text prompts.

**Away notifications** — while the dialog is open, `ask_user` holds the shared **agent-state** coordinator `blocked` (via `withAgentBlock` from [`@xynogen/pix-runtime`](https://www.npmjs.com/package/@xynogen/pix-runtime)). [`@xynogen/pix-notify`](https://www.npmjs.com/package/@xynogen/pix-notify) uses that state to play a sound when a question waits.

## Install

```bash
pi install npm:@xynogen/pix-ask
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
