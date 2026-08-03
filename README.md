# pix-mono

Monorepo of Pix, a distro of [Pi Coding Agent](https://github.com/badlogic/pi-mono).

> **🎨 Opinionated by design.** This distro reflects a specific terminal aesthetic and workflow. Colors, layout, information density, and visual choices are intentional — not configurable-by-default. Style PRs may be declined; capability PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

> **⚠ Expect breaking changes.** This project is under active development. Packages are regularly split, merged, renamed, or removed. The recommended upgrade path is to **uninstall then reinstall** the distro rather than incrementally updating individual packages. When in doubt, run the uninstall script first.

> **🐧 Linux and macOS tested.** This project has been tested on Linux and used successfully on macOS. Some tools are designed around Linux/Unix utilities and may be less efficient on macOS. Windows is **not tested** and may not work correctly.

## Packages

### Core bundle

Bundled together by [`@xynogen/pix-core`](packages/pix-core) — a single `pi install npm:@xynogen/pix-core` pulls and activates all of these.

**Libraries**

Shared dependencies pulled in automatically — install directly only if you need them standalone.

| Package | Description |
| --- | --- |
| [`@xynogen/pix-data`](packages/pix-data) | Shared model data layer (modelgrep catalog + coding score), cached at `~/.cache/pi` |
| [`@xynogen/pix-pretty`](packages/pix-pretty) | Enhanced tool output rendering — syntax highlighting, icons, tree views, FFF, gate-overlay |

**Theme**

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

**Behaviour**

| Package | Description |
| --- | --- |
| [`@xynogen/pix-optimizer`](packages/pix-optimizer) | Caveman mode + RTK tool rewriting + ponytail lazy-dev mode (`/optimizer` overlay) |
| [`@xynogen/pix-gate`](packages/pix-gate) | Permission gate for dangerous bash + path commands — 4 severity tiers (block/critical/dangerous/risky) + sudo redirect, configurable |
| [`@xynogen/pix-subagent`](packages/pix-subagent) | Sub-agent spawning — 3 tools (`agent`, `agent_result`, `agent_steer`), live model widget, work-splitting |

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

### Standalone extensions (opt-in)

Not bundled by `pix-core` — install each only if you want it. These are deliberately kept out of the default distro because each carries a setup cost or a sensitive capability: a provider API key, root execution, or a manual tool-toggling UI. Install with `pi install npm:@xynogen/<name>`.

| Package | Why it's opt-in |
| --- | --- |
| [`@xynogen/pix-9router`](packages/pix-9router) | 9Router LLM provider + `fetch`/`search`/`transcribe` tools — needs a 9Router API key, so only useful if you route through 9Router |
| [`@xynogen/pix-sudo`](packages/pix-sudo) | `sudo_run` — root execution via a PAM password overlay; a privileged capability you opt into explicitly (blocked in non-interactive mode) |
| [`@xynogen/pix-toolbox`](packages/pix-toolbox) | `/toolbox` — fuzzy-search picker to enable/disable tools at runtime; a power-user utility, not needed for normal use |
| [`@xynogen/pix-mcp`](packages/pix-mcp) | Token-efficient MCP gateway — external servers can execute commands or access sensitive services, so configure and enable it explicitly |

### Roadmap — third-party extensions

Upstream Pi community extensions we currently lean on. The future-development goal is to fork or rewrite these as first-class `@xynogen/pix-*` packages so they're maintained and bundled in-house.

| Package | Description |
| --- | --- |
| [`pi-lens`](https://github.com/apmantza/pi-lens) | Real-time code feedback — LSP navigation/diagnostics, linters, formatters, type-checking, structural (ast-grep) analysis |

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

### Graph analysis

The graph analyzer reads `graphify-out/graph.json`, validates inferred call edges against TypeScript bindings, removes invalid hyperedges, repairs recoverable hyperedge IDs, and extracts repeated structural and semantic patterns.

```bash
bun run graph:analyze
```

It writes the following files without replacing the original graph:

| Output | Description |
|---|---|
| `graphify-out/graph.cleaned.json` | Graph with unreliable inferred calls removed and source paths normalized |
| `graphify-out/patterns.json` | Machine-readable quality findings and extracted patterns |
| `graphify-out/PATTERN_REPORT.md` | Human-readable pattern and graph-quality report |

Use the cleaned graph for subsequent queries:

```bash
graphify query "your question" --graph graphify-out/graph.cleaned.json
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
| [`npm:pi-caveman`](https://www.npmjs.com/package/pi-caveman) | starting point for the `pix-optimizer` caveman-mode rewrite |
| `npm:pi-rtk-optimizer` | merged into `pix-optimizer` |
| [`git:github.com/DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail) | ruleset adapted as ponytail mode in `pix-optimizer` |
| `npm:@heyhuynhgiabuu/pi-pretty` | replaced by `@xynogen/pix-pretty` |
| `npm:@heyhuynhgiabuu/pi-diff` | superseded (merged into `pix-core`) |
| `npm:@juicesharp/rpiv-ask-user-question` | rewritten as the `ask-user` skill in `pix-skills` |
| [`git:github.com/tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) | spawn engine ported into `pix-subagent` |
| [`git:github.com/nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) | work-splitting design adapted in `pix-subagent` |
| [`git:github.com/nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) | v2.11.0 (`82724dc`) adopted as `@xynogen/pix-mcp`; MIT license retained, with bounded on-demand discovery and lazy startup behavior |

Previous standalone repos migrated into this monorepo: `pix-optimizer`, `pix-themes`, `pix-pretty`, `pix-core`, `pix-9router`, `pix-data`.

## License

MIT
