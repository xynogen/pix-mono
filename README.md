# pix-mono

Monorepo of Pix, a distro of [Pi Coding Agent](https://github.com/badlogic/pi-mono).

## What to install

**Just want the distro?** One package — `pix-core` pulls the rest:

```bash
pi install npm:@xynogen/pix-core
```

Or use the [one-shot installer](#install) to set up Pi, a theme, and the distro in one go. [Package breakdown](#packages) and [what's opt-in](#standalone-extensions-opt-in) below.

> **🎨 Opinionated** — visual choices are intentional; style PRs may be declined. See [CONTRIBUTING.md](CONTRIBUTING.md).
>
> **⚠ Breaking changes** — upgrade via [uninstall + reinstall](#upgrade--clean-reinstall), not incremental updates.
>
> **🐧 Linux/macOS** tested; Windows not.

## Packages

### Core bundle

Bundled together by [`@xynogen/pix-core`](packages/pix-core) — a single `pi install npm:@xynogen/pix-core` pulls and activates all of these.

You never install a shared library to "get the tools." It works the other way round: you install a feature package (or `pix-core`, which is all of them), and it quietly pulls in the small set of libraries it stands on. Those foundation packages are listed [at the bottom](#foundation-layer) so the parts you actually pick from come first.

**Theme** — standalone, zero deps

| Package | Description |
| --- | --- |
| [`@xynogen/pix-themes`](packages/pix-themes) | Theme pack — 7 dark themes |

**UI / UX extensions**

| Package | Description |
| --- | --- |
| [`@xynogen/pix-welcome`](packages/pix-welcome) | ASCII π banner + startup health checks (version, auth, models, tools, skills, gitignore) |
| [`@xynogen/pix-footer`](packages/pix-footer) | Status bar — mode, git branch, model, tokens, cost, live TPS |
| [`@xynogen/pix-models`](packages/pix-models) | `/models` — enhanced model picker with coding score/rank, context window, cost |
| [`@xynogen/pix-update`](packages/pix-update) | `/update` — self-update Pi + all extensions, detects install method |
| [`@xynogen/pix-commands`](packages/pix-commands) | `/clear` slash command (flushes `~/.cache/pi`) |
| [`@xynogen/pix-nudge`](packages/pix-nudge) | Tools nudge + capability nudge hooks to steer model toward correct tools |
| [`@xynogen/pix-diagnostics`](packages/pix-diagnostics) | Compact LSP diagnostic widget — recent files list, overrides pi-lens |
| [`@xynogen/pix-display`](packages/pix-display) | Paste chip rendering (`[paste image #1]`) + leaked `<think>` tag → native thinking blocks |
| [`@xynogen/pix-prompts`](packages/pix-prompts) | System-prompt injection — bundled `AGENT.md` baseline + repo directive files |
| [`@xynogen/pix-skills`](packages/pix-skills) | `read_skills` discovery and loader — names-only listing, description and full-instruction loading, reference reads, safe bundled resource copies, and on-demand TOON guidance |

### Tool suite

Bundled by `pix-core`. Drop-in replacements for the tools Pi exposes to the model (`read`, `write`, `edit`, `find`, `grep`, `ls`, `bash`, `todo`, `ask_user`). Each registers under the **same tool name** as the Pi built-in, so the model calls them transparently — no prompt changes needed. The only difference is the rendered output: syntax highlighting, side-by-side diffs, icon trees, and FFF-accelerated search, all via [`pix-pretty`](packages/pix-pretty). Install `pix-core` and the whole suite is active; the built-ins are shadowed.

| Package | Description |
| --- | --- |
| [`@xynogen/pix-bash`](packages/pix-bash) | `bash` — shell execution with framed output block and exit-code summary |
| [`@xynogen/pix-read`](packages/pix-read) | `read` — file read with syntax highlighting, image mime + size metadata |
| [`@xynogen/pix-write`](packages/pix-write) | `write` — file write with split-diff rendering on overwrite |
| [`@xynogen/pix-edit`](packages/pix-edit) | `edit` — precise text replacement with side-by-side diff per edit |
| [`@xynogen/pix-find`](packages/pix-find) | `find` — glob search with FFF acceleration and file icons |
| [`@xynogen/pix-grep`](packages/pix-grep) | `grep` — pattern search with FFF-prioritised results |
| [`@xynogen/pix-ls`](packages/pix-ls) | `ls` — directory listing as an indented icon tree |
| [`@xynogen/pix-ask`](packages/pix-ask) | `ask_user` — structured TUI questionnaire (multi-choice, multi-select, previews) |
| [`@xynogen/pix-todo`](packages/pix-todo) | `todo` — durable execution checklist, survives context compaction |

**Behaviour**

| Package | Description |
| --- | --- |
| [`@xynogen/pix-optimizer`](packages/pix-optimizer) | Caveman mode + RTK tool rewriting + ponytail lazy-dev mode (`/optimizer` overlay) |
| [`@xynogen/pix-gate`](packages/pix-gate) | Permission gate for dangerous bash + path commands — 4 severity tiers (block/critical/dangerous/risky) + sudo redirect, configurable |
| [`@xynogen/pix-subagent`](packages/pix-subagent) | Sub-agent spawning — 3 tools (`agent`, `agent_result`, `agent_steer`), live model widget, work-splitting |

### Standalone extensions (opt-in)

Not bundled by `pix-core` — install each only if you want it. These are deliberately kept out of the default distro because each carries a setup cost or a sensitive capability: a provider API key, root execution, or a manual tool-toggling UI. Install with `pi install npm:@xynogen/<name>`.

| Package | Why it's opt-in |
| --- | --- |
| [`@xynogen/pix-9router`](packages/pix-9router) | 9Router LLM provider + `fetch`/`search`/`transcribe` tools — needs a 9Router API key, so only useful if you route through 9Router |
| [`@xynogen/pix-sudo`](packages/pix-sudo) | `sudo_run` — root execution via a PAM password overlay; a privileged capability you opt into explicitly (blocked in non-interactive mode) |
| [`@xynogen/pix-ssh`](packages/pix-ssh) | `ssh_run` — run commands on a remote host over SSH (key/password auth + remote `sudo`); a networked, privileged capability you enable deliberately |
| [`@xynogen/pix-env`](packages/pix-env) | Broker `.env` secrets to tools via `$KEY` references without putting the values in the model's context; opt-in since it wires secret injection |
| [`@xynogen/pix-toolbox`](packages/pix-toolbox) | `/toolbox` — fuzzy-search picker to enable/disable tools at runtime; a power-user utility, not needed for normal use |
| [`@xynogen/pix-mcp`](packages/pix-mcp) | Token-efficient MCP gateway — external servers can execute commands or access sensitive services, so configure and enable it explicitly |
| [`@xynogen/pix-graph`](packages/pix-graph) | `graph` tool — native-TS code knowledge graph (build/query, no Python); TS/JS only, opt-in extra for codebase Q&A |

### Roadmap — third-party extensions

Upstream Pi community extensions we currently lean on. The future-development goal is to fork or rewrite these as first-class `@xynogen/pix-*` packages so they're maintained and bundled in-house.

| Package | Description |
| --- | --- |
| [`pi-lens`](https://github.com/apmantza/pi-lens) | Real-time code feedback — LSP navigation/diagnostics, linters, formatters, type-checking, structural (ast-grep) analysis |

### Foundation layer

The bottom of the dependency tree. Every feature package above depends on these, so they arrive automatically whenever you install anything else — you rarely install them on purpose. Reach for one directly only when you're building your own extension against it.

`pi install npm:@xynogen/pix-core` resolves to the 25 feature packages, each of which pulls `pix-pretty` and `pix-runtime` (a few also `pix-data`). `pix-pretty` in turn brings four third-party libraries (`chalk`, `cli-highlight`, `@ff-labs/fff-node`, `diff`), and the packages with tool schemas add `typebox`. That's the whole tree. Install a single package like `pix-read` and the same foundation resolves — you just get one tool instead of the distro.

| Package | Depends on | Description |
| --- | --- | --- |
| [`@xynogen/pix-runtime`](packages/pix-runtime) | — (zero deps) | Base runtime — `pix.json` config, `once()` guard, collapse policy. Everything sits on this. |
| [`@xynogen/pix-pretty`](packages/pix-pretty) | `pix-runtime` + `chalk`, `cli-highlight`, `@ff-labs/fff-node`, `diff` | Rendering lib — syntax highlighting, icons, tree views, diff, FFF, gate-overlay |
| [`@xynogen/pix-data`](packages/pix-data) | `pix-runtime` | Model data layer (modelgrep catalog + coding score), cached at `~/.cache/pi` |

## Install

One-shot installer — installs Pi, sets theme/tools, then installs the whole pix distro.

Straight from GitHub (no clone needed):

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

Or from a local clones:

```bash
sh scripts/install.sh   # or: bun run distro:install
```

## Uninstall

Removes all `@xynogen/pix-*` packages from Pi. Also cleans up sub-packages from older installs that listed them individually.

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/uninstall.sh | sh
```

Or from a local checkout:

```bash
sh scripts/uninstall.sh   # or: bun run distro:uninstall
```

### Upgrade / clean reinstall

When upgrading across breaking changes, uninstall first:

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/uninstall.sh | sh
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

## Development

```bash
bun install        # install all workspace deps
bun test           # run all tests
bun run typecheck  # tsc across all packages
```

## Publishing

```bash
bun run static-analysis  # run the pre-publish gate directly
bun run publish:dry      # run the gate, then verify what would be published
bun run publish:all      # run the gate, then publish every new package version
```

The pre-publish gate runs Biome, TypeScript, dependency-policy tests, and a high-severity dependency audit before any npm registry request. A failure preserves the analyzer output and prints a GitHub Actions `::error` annotation plus a `STATIC_ANALYSIS_FAILURE=<json>` marker containing the failed check, command, exit code, and exact reproduction command. This lets humans and CI coding agents identify and rerun the failing stage from the logs.

## Lineage

Several packages here originated as forks or merges of community Pi packages:

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

Previous standalone repos migrated into this monorepo: `pix-optimizer`, `pix-themes`, `pix-pretty`, `pix-core`, `pix-9router`, `pix-data`.

## License

MIT
