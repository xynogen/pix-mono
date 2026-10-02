# pix-mono

Monorepo of Pix, a distro of [Pi Coding Agent](https://github.com/badlogic/pi-mono).

## What to install

**Do you want the distro?** One package. `pix-core` installs the rest:

```bash
pi install npm:@xynogen/pix-core
```

Or use the [one-shot installer](#install). It installs Pi, a theme, and the distro together. See the [package breakdown](#packages) and [what is opt-in](#standalone-extensions-opt-in) below.

> **🎨 Opinionated** — the visual choices are intentional. A style PR may be declined. See [CONTRIBUTING.md](CONTRIBUTING.md).
>
> **⚠ Breaking changes** — upgrade through [uninstall + reinstall](#upgrade--clean-reinstall), not an incremental update.
>
> **🐧 Linux/macOS** tested. Windows has its own installer and per-OS code paths, but CI runs on Linux only.

## Packages

### Core bundle

One `pi install npm:@xynogen/pix-core` installs and activates every package below. Each package installs the [foundation libraries](#foundation-layer) it needs.

### Theme

Standalone, zero deps.

| Package | Description |
| --- | --- |
| [`@xynogen/pix-themes`](https://www.npmjs.com/package/@xynogen/pix-themes) | Theme pack — 7 dark themes |

### UI / UX extensions

Widgets, slash commands, and display changes for the TUI.

| Package | Description |
| --- | --- |
| [`@xynogen/pix-welcome`](https://www.npmjs.com/package/@xynogen/pix-welcome) | ASCII π banner + startup health checks (version, auth, models, tools, skills, gitignore) |
| [`@xynogen/pix-footer`](https://www.npmjs.com/package/@xynogen/pix-footer) | Status bar — mode, git branch, model, tokens, cost, live TPS |
| [`@xynogen/pix-models`](https://www.npmjs.com/package/@xynogen/pix-models) | `/models` — enhanced model picker with coding score/rank, context window, cost |
| [`@xynogen/pix-update`](https://www.npmjs.com/package/@xynogen/pix-update) | `/update` — self-update Pi + all extensions, detects install method |
| [`@xynogen/pix-commands`](https://www.npmjs.com/package/@xynogen/pix-commands) | `/clear` (flushes `~/.cache/pi`), `/btw` isolated side question, `/afk` and `/yolo` unattended-run modes |
| [`@xynogen/pix-nudge`](https://www.npmjs.com/package/@xynogen/pix-nudge) | Tools nudge + capability nudge hooks to steer model toward correct tools |
| [`@xynogen/pix-diagnostics`](https://www.npmjs.com/package/@xynogen/pix-diagnostics) | Lazy LSP diagnostics, navigation, and a compact session widget — replaces the pi-lens LSP core |
| [`@xynogen/pix-display`](https://www.npmjs.com/package/@xynogen/pix-display) | Paste chip rendering (`[paste image #1]`) + leaked `<think>` tag → native thinking blocks |
| [`@xynogen/pix-prompts`](https://www.npmjs.com/package/@xynogen/pix-prompts) | System-prompt injection — bundled `SOP.md` baseline + repo directive files |
| [`@xynogen/pix-skills`](https://www.npmjs.com/package/@xynogen/pix-skills) | `read_skills` discovery and loading — includes references, bundled resources, and on-demand TOON guidance |

### Tool suite

These packages replace Pi's built-in tools under the same names. So model calls stay unchanged. [`pix-pretty`](https://www.npmjs.com/package/@xynogen/pix-pretty) improves their output: highlighting, diffs, icon trees, and FFF search.

| Package | Description |
| --- | --- |
| [`@xynogen/pix-bash`](https://www.npmjs.com/package/@xynogen/pix-bash) | `bash` — shell execution with framed output block and exit-code summary |
| [`@xynogen/pix-powershell`](https://www.npmjs.com/package/@xynogen/pix-powershell) | `powershell` — same framed rendering for Pi's optional Windows tool; inert unless you enable `powershell` |
| [`@xynogen/pix-read`](https://www.npmjs.com/package/@xynogen/pix-read) | `read` — file read with syntax highlighting, image mime + size metadata |
| [`@xynogen/pix-write`](https://www.npmjs.com/package/@xynogen/pix-write) | `write` — file write with split-diff rendering on overwrite |
| [`@xynogen/pix-edit`](https://www.npmjs.com/package/@xynogen/pix-edit) | `edit` — precise text replacement with side-by-side diff per edit |
| [`@xynogen/pix-find`](https://www.npmjs.com/package/@xynogen/pix-find) | `find` — glob search with FFF acceleration and file icons |
| [`@xynogen/pix-grep`](https://www.npmjs.com/package/@xynogen/pix-grep) | `grep` — pattern search with FFF-prioritised results |
| [`@xynogen/pix-ls`](https://www.npmjs.com/package/@xynogen/pix-ls) | `ls` — directory listing as an indented icon tree |
| [`@xynogen/pix-ask`](https://www.npmjs.com/package/@xynogen/pix-ask) | `ask_user` — structured TUI questionnaire (multi-choice, multi-select, previews) |
| [`@xynogen/pix-todo`](https://www.npmjs.com/package/@xynogen/pix-todo) | `todo` — durable execution checklist, survives context compaction |

### Behaviour

How the agent acts — output optimization, permission gate, and sub-agents.

| Package | Description |
| --- | --- |
| [`@xynogen/pix-optimizer`](https://www.npmjs.com/package/@xynogen/pix-optimizer) | Caveman mode + RTK tool rewriting + ponytail lazy-dev mode (`/optimizer` overlay) |
| [`@xynogen/pix-gate`](https://www.npmjs.com/package/@xynogen/pix-gate) | Permission gate for dangerous bash + path commands — 4 severity tiers (block/critical/dangerous/risky) + sudo redirect, configurable |
| [`@xynogen/pix-subagent`](https://www.npmjs.com/package/@xynogen/pix-subagent) | Sub-agent spawning — 2 tools (`agent`, `agent_control`), live model widget, work-splitting |

### Standalone extensions (opt-in)

Not bundled by `pix-core`. Install each one only if you want it. Each one stays out of the default distro because it has a setup cost or a sensitive capability: a provider API key, root execution, or a manual tool-toggle UI. Install with `pi install npm:@xynogen/<name>`.

| Package | Why it's opt-in |
| --- | --- |
| [`@xynogen/pix-web`](https://www.npmjs.com/package/@xynogen/pix-web) | Provider-neutral `fetch` and `search` tools with Exa, Tavily, You.com, Brave, SearXNG, 9Router, and more adapters |
| [`@xynogen/pix-voice`](https://www.npmjs.com/package/@xynogen/pix-voice) | Provider-neutral push-to-talk dictation (`Ctrl+Alt+Z`) plus the `transcribe` and `speak` tools, with 9Router, OpenAI, Groq, Deepgram, ElevenLabs, Gemini, and more adapters |
| [`@xynogen/pix-9router`](https://www.npmjs.com/package/@xynogen/pix-9router) | 9Router LLM provider — needs a 9Router API key |
| [`@xynogen/pix-sudo`](https://www.npmjs.com/package/@xynogen/pix-sudo) | `sudo_run` — root execution via a PAM password overlay (blocked in non-interactive mode) |
| [`@xynogen/pix-ssh`](https://www.npmjs.com/package/@xynogen/pix-ssh) | `ssh_run` — run commands on a remote host over SSH (key/password auth + remote `sudo`) |
| [`@xynogen/pix-env`](https://www.npmjs.com/package/@xynogen/pix-env) | Broker `.env` secrets to tools via `$KEY` references, keeping the values out of the model's context |
| [`@xynogen/pix-toolbox`](https://www.npmjs.com/package/@xynogen/pix-toolbox) | `/toolbox` — fuzzy-search picker to enable/disable tools at runtime |
| [`@xynogen/pix-mcp`](https://www.npmjs.com/package/@xynogen/pix-mcp) | Token-efficient MCP gateway — external servers can execute commands or reach sensitive services |
| [`@xynogen/pix-codemode`](https://www.npmjs.com/package/@xynogen/pix-codemode) | Native `codemode` with highlighted JavaScript, formatted JSON, and Pix result frames |
| [`@xynogen/pix-graph`](https://www.npmjs.com/package/@xynogen/pix-graph) | `graph` tool — native-TS code knowledge graph (build/query, no Python); TS/JS only |
| [`@xynogen/pix-astgrep`](https://www.npmjs.com/package/@xynogen/pix-astgrep) | `ast_grep_search` / `read_symbol` / `symbol_search` — structural code search and symbol reads; needs the `@ast-grep/napi` native addon |
| [`@xynogen/pix-hunk`](https://www.npmjs.com/package/@xynogen/pix-hunk) | `hunk` tool — live Hunk diff-review bridge; needs the external Hunk CLI and an active review session |
| [`@xynogen/pix-aria2`](https://www.npmjs.com/package/@xynogen/pix-aria2) | `download` tool — fast, resumable downloads via an auto-managed aria2 RPC daemon; needs the external `aria2c` binary |
| [`@xynogen/pix-proc`](https://www.npmjs.com/package/@xynogen/pix-proc) | `proc` tool — run and manage long-lived processes (`npm run dev`, `vite`, `python`) that outlive a turn; spawns background processes |
| [`@xynogen/pix-search`](https://www.npmjs.com/package/@xynogen/pix-search) | `@` file picker with fuzzy + git-recency ranking and a live preview; overrides Pi's built-in `@` autocomplete |

### Roadmap — third-party extensions

Upstream Pi extensions that Pix uses now. We plan to replace each one with a maintained `@xynogen/pix-*` package.

| Package | Description |
| --- | --- |
| [`pi-lens`](https://github.com/apmantza/pi-lens) | LSP core merged into `pix-diagnostics`. Still upstream: linters, formatters, structural (ast-grep) analysis, security/dependency scans |

### Foundation layer

Installed with any feature package. Install one directly only when you build your own extension against it. The `Depends on` column shows the full tree.

| Package | Depends on | Description |
| --- | --- | --- |
| [`@xynogen/pix-runtime`](https://www.npmjs.com/package/@xynogen/pix-runtime) | — (zero deps) | Base runtime used by every feature package — `pix.json` config, `once()` guard, collapse policy, binary catalog (`binary.json` overrides, resolve, verified download), and per-OS exec/open/clipboard/git jobs |
| [`@xynogen/pix-pretty`](https://www.npmjs.com/package/@xynogen/pix-pretty) | `pix-runtime` + `chalk`, `cli-highlight`, `@ff-labs/fff-node`, `diff` | Rendering lib — syntax highlighting, icons, tree views, diff, FFF, gate-overlay |
| [`@xynogen/pix-data`](https://www.npmjs.com/package/@xynogen/pix-data) | `pix-runtime` | Model data layer (modelgrep catalog + coding score), cached at `~/.cache/pi` |

## Install

Each installer does 5 steps: install or update Pi, then install `pix-core` + `pix-themes`, recommended code intelligence, optional Pix extensions, and optional community extensions. It asks before each optional package. It is safe to re-run.

From a local clone, one command picks the right script for your OS:

```bash
bun run distro:install     # Windows → scripts/install.ps1, Linux/macOS → scripts/install.sh
bun run distro:uninstall
```

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

- **Prerequisite:** [Bun](https://bun.sh). The installer falls back to npm when Bun is missing.
- **PATH:** after the install, `pi` must be on `PATH`. If it is not, add the global bin dir (`~/.bun/bin` for Bun) to your shell rc, then re-run.
- **Clipboard image paste:** needs `wl-paste` (Wayland, package `wl-clipboard`) or `xclip` (X11).
- **Opening URLs** (MCP OAuth): uses `xdg-open` (package `xdg-utils`).
- **User `!` commands** run through `$SHELL`. For zsh, the command sources `.zshrc`, so aliases work.
- **`pix-sudo`:** it needs `sudo` with PAM. Your `sudo` ticket timeout decides how often it asks for a password.
- **WSL:** use the Linux installer inside WSL. `wslview` and `wslpath` open links and paths on the Windows side.
- **External tools** (`aria2c`, `ffmpeg`): install them with `apt`, `dnf`, or `pacman`. `ffmpeg` also downloads automatically into `~/.pi/agent/bin` on first use.

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

- **Prerequisite:** [Bun](https://bun.sh) (or npm). You need Git from `xcode-select --install`.
- **External tools:** install with Homebrew: `brew install aria2 ffmpeg`, and `brew install sshpass` for `pix-ssh` password login. Pix does not download `ffmpeg` on macOS.
- **Opening URLs:** uses the built-in `open`.
- **User `!` commands** run through `$SHELL`. zsh is the macOS default, so `.zshrc` aliases work.
- **`pix-sudo`:** the installer offers it. It uses the macOS `sudo` + PAM.

### Windows

Run in Windows PowerShell 5.1 or PowerShell 7:

```powershell
irm https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.ps1 | iex
```

- **Pi install:** the script runs Pi's official installer (`pi.dev/install.ps1`). That installer also sets up Node.js and Git Bash when they are missing.
- **Bash for the model:** Pi's `bash` tool needs Git Bash. If the installer finds no Bash, run `winget install --id Git.Git -e`, or set `shellPath` in `~/.pi/agent/settings.json`.
- **User `!` commands** run through PowerShell (`pwsh` 7, else `powershell.exe` 5.1), not Git Bash.
- **PATH:** if `pi` is not found after the install, restart the terminal and re-run the installer.
- **`powershell` tool:** Pi's optional `powershell` tool stays off until you enable it. On 5.1, `pix-powershell` rewrites `&&` / `||`, and it shows a note when it does.
- **`pix-sudo` is not offered.** Windows has no `sudo` + PAM. The installer prints the manual `pi install` command.
- **`pix-ssh`:** needs an `ssh` with ControlMaster support first on `PATH`. The Git for Windows `ssh` works. The built-in Windows OpenSSH does not. Password login also needs `sshpass`.
- **`pix-voice`:** push-to-talk records through `ffmpeg` (DirectShow). `speak` plays through the built-in `MediaPlayer`. A missing `ffmpeg` downloads automatically on first use.
- **External tools:** use `winget`, for example `winget install aria2.aria2`, `winget install Gyan.FFmpeg`, or `winget install rtk-ai.rtk`.
- **CI:** it runs on Linux only, so Windows gets less test coverage.

### Uninstall

This removes every `@xynogen/pix-*` package from Pi. It also removes the sub-packages that an older install listed one by one.

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/uninstall.sh | sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/uninstall.ps1 | iex
```

### Upgrade / clean reinstall

Before you upgrade across breaking changes, uninstall first, then install again. Use the uninstall and install commands for your OS above. From a local clone:

```bash
bun run distro:uninstall && bun run distro:install
```

Windows PowerShell 5.1 has no `&&`. Run the two commands one after the other.

## Development

```bash
bun install        # install all workspace deps
bun run check      # biome lint + format
bun run typecheck  # tsc across all packages
bun run test       # run all tests (isolated)
bun run dev:link   # symlink packages into Pi (restart Pi after)
```

## Publishing

```bash
bun run static-analysis  # run the pre-publish gate directly
bun run publish:dry      # run the gate, then verify what would be published
bun run publish:all      # run the gate, then publish every new package version
```

Before a publish, the gate runs Biome, TypeScript, the dependency-policy tests, and a high-severity dependency audit. On a failure it keeps the analyzer output. It prints the failed check, the exit code, and the reproduction command for a human or a CI agent.

## Lineage

Several packages here started as a fork or a merge of a community Pi package:

| Upstream | Disposition |
|---|---|
| [`jonjonrankin/pi-caveman`](https://github.com/jonjonrankin/pi-caveman) | starting point for the `pix-optimizer` caveman-mode rewrite |
| [`MasuRii/pi-rtk-optimizer`](https://github.com/MasuRii/pi-rtk-optimizer) | merged into `pix-optimizer` |
| [`DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail) | ruleset adapted as ponytail mode in `pix-optimizer` |
| [`heyhuynhgiabuu/pi-pretty`](https://github.com/heyhuynhgiabuu/pi-pretty) | replaced by `@xynogen/pix-pretty` |
| [`buddingnewinsights/pi-diff`](https://github.com/buddingnewinsights/pi-diff) | superseded (merged into `pix-core`) |
| [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) | rewritten as the `ask-user` skill in `pix-skills` |
| [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) | spawn engine ported into `pix-subagent` |
| [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) | work-splitting design adapted in `pix-subagent` |
| [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) | v2.11.0 (`82724dc`) adopted as `@xynogen/pix-mcp`; MIT license retained, with bounded on-demand discovery and lazy startup behavior |
| [`earendil-works/pi-voice`](https://github.com/earendil-works/pi-voice) | push-to-talk dictation design (`Ctrl+Alt+Z` into the prompt) adapted in `pix-voice`; no code copied |
| [`apmantza/pi-lens`](https://github.com/apmantza/pi-lens) | LSP engine (server registry, transport, lazy manager) adapted into `@xynogen/pix-diagnostics`; MIT license retained in `packages/pix-diagnostics/LICENSE.pi-lens` |

These standalone repos moved into this monorepo before: `pix-optimizer`, `pix-themes`, `pix-pretty`, `pix-core`, `pix-9router`, `pix-data`.

## License

MIT
