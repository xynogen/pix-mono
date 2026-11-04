<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-prompts

Pi extension — system-prompt injection (SOP.md + repo directives).

## What it does

Injects structured context into the system prompt at the start of every agent turn via `before_agent_start`. It first replaces Pi's default coding-assistant identity line with `You are Pix Coding Agent. You help users accomplish any task they request.` Two sources are then injected in order: the bundled `SOP.md` (the pix agent operating spec baseline), followed by repo-root directive files the Pi host does not load (`GEMINI.md`, `.cursorrules`, `.windsurfrules`). Each source is wrapped in a labelled XML tag for provenance.

The bundled `SOP.md` sets an STE100-inspired (not strict [ASD-STE100](https://asd-ste100.org)) reply style under §6: common words, short sentences, the active voice, and a next-action-first reply shape. Standard English technical terms stay untranslated.

Injection is **idempotent and host-aware**. A file is skipped when either our own tag is already present (retry turns) or the Pi host has injected that same absolute path as `<project_instructions path="...">`. Pi natively owns `AGENTS.md` and `CLAUDE.md`; pix-prompts intentionally does not scan them, preventing duplicate injection when host and extension paths use different normalization.

## Install

```bash
pi install npm:@xynogen/pix-prompts
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
