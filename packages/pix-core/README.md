# pix-core

Pi coding agent extension — core UI/UX meta-package.

Installing `pix-core` pulls in all of the packages below as npm dependencies **and activates them**. A single `pi install npm:@xynogen/pix-core` boots every core extension — you do not need to install the members individually.

## How it works

Pi activates extensions per installed package via each package's `pi.extensions` manifest; it does not walk npm dependencies. So `pix-core` ships a thin aggregator (`src/extension.ts`) that imports each member's extension factory and invokes it against the same host. Each member also carries a `globalThis` idempotency guard, so installing `pix-core` **and** a member standalone activates that member only once.

## What's included

**UI / UX extensions**

| Package | Description |
|---|---|
| `pix-welcome` | ASCII π banner + startup health checks (version, auth, models, gitignore) |
| `pix-footer` | Status bar: mode / git branch / model / cost / live TPS |
| `pix-models` | `/models` — enhanced model picker with coding score/rank, context, cost |
| `pix-update` | `/update` — self-update Pi + refresh extensions |
| `pix-commands` | Slash commands — `/clear` and concurrent, context-isolated `/btw` side questions |
| `pix-diagnostics` | Compact LSP diagnostic widget |
| `pix-display` | Paste chip rendering + thinking block display |
| `pix-prompts` | System-prompt injection (AGENTS.md + repo directive files) |
| `pix-skills` | Agent skill loader (`read_skills` tool + bundled on-demand skills, including TOON) |
| `pix-nudge` | Tool + capability nudge hooks |

**Tool suite** (drop-in replacements for Pi's built-in tools)

| Package | Description |
|---|---|
| `pix-read` | `read` — file read with syntax highlighting |
| `pix-write` | `write` — file write with split-diff rendering |
| `pix-edit` | `edit` — precise text replacement with per-edit diff |
| `pix-find` | `find` — glob search with FFF acceleration |
| `pix-grep` | `grep` — pattern search with FFF-prioritised results |
| `pix-ls` | `ls` — directory listing as an icon tree |
| `pix-bash` | `bash` — shell execution with framed output + exit-code summary |
| `pix-powershell` | `powershell` — same rendering for Pi's optional Windows tool; inert unless you enable `powershell` |
| `pix-todo` | `todo` — durable execution checklist |
| `pix-ask` | `ask_user` — structured TUI questionnaire |

**Shared data + behaviour**

| Package | Description |
|---|---|
| `pix-data` | Shared model data layer (modelgrep + BenchLM) cached at `~/.cache/pi` |
| `pix-runtime` | Unified `~/.pi/agent/pix.json` config runtime, `/pix` settings command, once guard, and auto-collapse policy |
| `pix-optimizer` | Caveman mode + RTK tool rewriting + ponytail lazy-dev mode (`/optimizer`) |
| `pix-gate` | Permission gate for dangerous bash commands |
| `pix-subagent` | `agent` / `agent_control` — planner-driven sub-agents with live widget |
| `compaction` | Built into pix-core: replaces pi's built-in context compaction with two levers. **Summary prompt is always pix's** — every compaction (manual `/compact`, threshold, overflow) generates the summary with the current conversation model (no silent routing) from an editable source prompt. **Trigger is pix's when `compaction.triggerPercent > 0`** — after each settled turn pix reads live context usage and compacts at `max(contextWindow × triggerPercent, compaction.minimumTokens)`. The default 100K floor prevents low percentages from compacting too early (for example, 10% of a 300K model waits for 100K rather than 30K); `0` disables pix's trigger and lets pi decide, while pix's summary prompt still applies. After a pix-triggered compaction pix sends a short, visible "resume" user message so the agent continues on its own. Every trigger, resume, and summary run emits a notify line (reason, model, token counts). |

## Plan mode

Use `/plan` to create, edit, execute, or delete saved plans in `<project>/.pi/plans/`.
Use `Shift+Tab` or `Ctrl+Alt+P` to toggle plan mode.
Use `Tab` in an empty prompt to cycle the thinking level.

Plan mode keeps the available tools unchanged.
Only `edit` and `write` are restricted to files inside the current project's `.pi/plans/`.
The guard rejects other project paths, path traversal outside this directory, and symlink targets or parents.
The same restrictions apply when a session restores plan mode.

Other tools, including shell commands, are not sandboxed by plan mode.
The visible plan guide asks the agent to explore without changing project files.
Use `pix-gate` for command restrictions.

## Install

```bash
pi install npm:@xynogen/pix-core
```

> Installs and activates every bundled pix package. A package that you also install directly loads only once.

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
