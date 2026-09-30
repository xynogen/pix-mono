<!-- markdownlint-disable MD013 MD040 MD060 -->

# pix-mono — Agent Operating Guide

Monorepo of Pix, a distro of Pi Coding Agent extensions (`@xynogen/pix-*`).
**Bun** runtime · **Biome** lint/format · **tsc** types · **bun run test** tests · all ESM (`"type": "module"`, ES2022). Packages ship TypeScript source. There is no build step.

Sections 1–4 explain the design. Sections 5–9 are the rules that keep packages consistent. Sections 10–12 are workflow. Detail lives in `docs/architecture.md` and `docs/release.md`.

---

## 1. Product Design Philosophy

Pix is a **transparent, token-efficient, model-flexible** Pi distro. These are product constraints, not optional preferences. Apply them when you design, implement, or review every feature.

### 1.1 Minimize token use

- Keep the baseline system prompt and recurring tool schemas small.
- Load skills, instructions, model catalogs, and volatile metadata only on demand.
- Prefer targeted reads, bounded previews, compact structured results, and edit formats that reduce retries.
- Inject prompts only when the current task needs them. Avoid passive or always-on context.
- UI collapse may reduce visual clutter, but the complete result must stay expandable and available to the user and agent.
- Measure token savings where possible. Do not make unverified efficiency claims.
- Avoid always-on advisors, reviewers, background loops, verbose orchestration transcripts, and giant all-purpose tool schemas.

### 1.2 Preserve strong model flexibility

- The user or calling agent chooses the model for each task.
- Pix may show benchmark scores, context size, price, capabilities, and recommendations, but must not silently pin or route to a model/provider.
- Subagents inherit the parent model when omitted or use the caller's explicit `model`. An agent type/persona must not override that choice.
- Any fallback or model change must be visible and report the reason, previous model, replacement model, and relevant cost/capability difference.
- Prefer provider-neutral interfaces. Avoid features that create provider lock-in.

### 1.3 Keep agent behavior visible

- Every meaningful read, command, edit, delegation, approval, retry, and result must appear in the transcript or live UI.
- Show subagent identity, selected model, scope, current activity, token/cost information when available, and final output.
- Show file changes as inspectable diffs and findings with paths/evidence.
- Users must be able to inspect, expand, steer, stop, approve, reject, or undo work where the operation permits it.
- Never discard details only because a card is collapsed. Collapsing is presentation, not concealment.
- Memory, if added, must be explicit and auditable: visible retain/recall operations, provenance, injected-token estimate, and list/edit/delete controls.

### 1.4 Prefer composability over magic

- Build complex behavior from ordinary, visible tools and subagents.
- Convenience UI may prepare, organize, or summarize a workflow, but must not conceal its plan, model routing, tool calls, retries, edits, or review steps.
- Avoid any opaque high-level command, shortcut, trigger, or mode that silently starts planning, routing, tool use, retries, edits, delegation, or background automation. A `/goal`-style command or magic word is one example of this anti-pattern.
- Reviews must be explicitly invoked and show reviewer models, scopes, token use, evidence, deduplication, and verdict construction. Do not run an always-on reviewer by default.

### 1.5 Feature review checklist

Before you accept a feature, answer:

1. Does it reduce or needlessly add baseline/context/output tokens?
2. Can the user choose the model and provider without a hidden override?
3. Can the user see what ran, why it ran, what it read or changed, and what it cost?
4. Can the user inspect, steer, stop, approve, reject, or undo it where applicable?
5. Is it composed from visible primitives rather than opaque automation?
6. Is a sensitive, expensive, or setup-heavy capability opt-in instead of bundled by default?

Product promise: **No hidden intent. No silent routing. No blind automation.**

---

## 2. Architecture

Layers, low to high: **L0** `pix-runtime` → **L1** `pix-pretty`, `pix-data` → **L2** feature packages → **L3** `pix-core` (aggregator). A package imports only from lower layers, plus the Pi host (peer deps).

- Every factory wraps its body in `once(pi, "<pkg>", …)` from `@xynogen/pix-runtime/once`. Pi re-evaluates modules on every reload, so process-wide state lives on `globalThis`.
- A new bundled package needs three edits in `pix-core`: a dependency, an import, and an entry in `MEMBERS`.
- The reference package shape is `packages/pix-ls`.

Read [`docs/architecture.md`](docs/architecture.md) before you add a package, a shared helper, or a cross-package import. It has the layer diagram, load model, package anatomy, and import resolution.

---

## 3. Shared layers

**Before you write a helper, search the shared layers.** `pix-runtime` (config, paths, exec, binaries, io, atomic write), `pix-pretty` (frames, diffs, icons, widgets, overlays), `pix-data` (model metadata, `formatCost`), and the Pi API (`truncateHead`, `DEFAULT_MAX_BYTES`, `pi-tui`). The subpath tables are in [`docs/architecture.md`](docs/architecture.md#3-shared-layers--what-to-use-instead-of-writing-your-own). Check each package `package.json#exports` for the full list.

---

## 4. When to share, when to keep local

- **One-off helper** (bespoke summary line, single-use parser) → keep it in the package.
- **Same helper in two packages, or about to be copied** → move it to the lowest layer that fits and delete the copies in the same change.
  - OS, paths, config, processes, files → `pix-runtime`.
  - Text, layout, color, formatting, overlays → `pix-pretty`.
  - Model/provider metadata → `pix-data`.
- **Node or Pi already does it** → use that. Examples: `node:util` `stripVTControlCharacters`, `AbortSignal.timeout`, Pi `truncateHead`.
- **A one-line idiom in two places** (for example a BOM strip before `JSON.parse`) → a shared helper can cost more than it saves. Use judgement and say why.
- Shared helpers take minimal structural types (`ThemeLike`, `SessionLike`, `UILike`), not the full `ExtensionAPI` or unrelated host state. They stay pure and host-agnostic.
- Non-trivial shared helpers ship with focused tests in the shared package.
- Do not add a new cross-package edge between feature packages. If two features need the same code, move it down a layer.

---

## 5. Import Boundary

Import another package only through a declared public export:

```ts
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { frameLines, modalWidth } from "@xynogen/pix-pretty/modal-frame";
```

Never import another package by filesystem path or source internals:

```ts
// forbidden
import { icon } from "../../pix-pretty/src/icon-catalog.ts";
import { icon } from "@xynogen/pix-pretty/src/icon-catalog.ts";
```

- Before you use a subpath, verify it exists in that package's `package.json#exports`. A missing subpath means add one public export or keep the code local. Do not bypass the boundary.
- Package-internal relative imports stay valid.
- Adding a public helper or subpath to `pix-pretty`, `pix-runtime` or `pix-data` is a public API addition. It needs a minor bump (0.x) and consumer pin updates. See section 10.

---

## 6. Paths, Binaries and Config

### 6.1 Paths

- Use `@xynogen/pix-runtime/paths`: `homeDir()`, `expandHome()`, `agentDir()`, `binDir()`, `projectDir(cwd)`, `tempDir()`, `cacheDir()`.
- Never hardcode `~/.pi/agent`. Never read `process.env.HOME` for directories. Never call `os.homedir()` directly in a feature package.
- Text shown to the model or the user keeps `/` as the separator. Build it as `` `${projectDir()}/x` ``, not with `join`.
- Tests use the same helpers. No static paths in tests. The preload `scripts/test-sandbox.ts` points `HOME`, `USERPROFILE` and `PI_CODING_AGENT_DIR` at a throwaway folder before any test module loads.

### 6.2 Binaries — `~/.pi/agent/binary.json`

Every external command a pix package runs is listed in the pix-runtime catalog (`packages/pix-runtime/src/binaries/catalog.ts`).

- **Run:** start catalogued binaries only through `@xynogen/pix-runtime/exec` (`runTool` / `spawnTool` / `runToolSync`), or `@xynogen/pix-runtime/os` for per-OS jobs (`openTarget`, `runGit`, `readClipboardImage`). Never call `spawn("git")`, `execFile("ssh")` or `pi.exec("npm")` by bare name. `scripts/binaries.test.ts` enforces this. The layer handles `binary.json`, Windows `.cmd` shims and install hints.
- **Resolve:** `resolveTool` / `requireTool` / `ensureTool` from `@xynogen/pix-runtime/binaries` when you only need the path. Do not add a package-local PATH lookup, a `command -v` shell-out, or an ENOENT probe.
- **Status:** route download progress through `reportToolStatus(ctx.ui)`, and background missing-binary errors through `warnBinaryMissing(ctx.ui, err)`, both from `@xynogen/pix-pretty/tool-status`.
- **`binary.json`:** user config. It holds overrides only (`name → path`). A missing entry means automatic (`bin` → known install dirs → PATH → download). pix never writes discovered paths into it, and never creates it until the user sets a path. The `/pix` Binaries tab shows the full catalog and edits the file.
- **New command dependency:** add it to the catalog, with every OS and an install hint, in the same change.

### 6.3 Unified config — `~/.pi/agent/pix.json`

Owned by `pix-runtime` (init/reload/flush + the `/pix` settings command). Auto-created with defaults on first session.

| Section | Consumers |
|---|---|
| `collapse` | pix-ask, pix-edit, pix-find, pix-grep, pix-hunk, pix-ls, pix-mcp, pix-read, pix-skills, pix-ssh, pix-subagent, pix-sudo, pix-todo, pix-voice, pix-web, pix-write, and pix-bash/pix-powershell through `pix-pretty/shell-tool` |
| `pretty` | pix-pretty (icons, preview/render limits, diff split thresholds) |
| `io` | pix-9router, pix-data, pix-mcp, pix-skills, pix-update, pix-voice, pix-web (network timeout via `@xynogen/pix-runtime/io`) |
| `compaction` | pix-core (auto-compaction trigger percent and token floor) |
| `optimizer` | pix-optimizer (caveman/rtk/ponytail state) |
| `gate` | pix-gate (rules, auto-approve patterns) |

Loader: `@xynogen/pix-runtime/config` · sections: `@xynogen/pix-runtime/sections` · collapse: `@xynogen/pix-runtime/collapse`. Full schema in `packages/pix-runtime/README.md`.

---

## 7. UI Rules

### 7.1 Icon catalog

**Never hardcode Nerd Font glyph codepoints.** Terminals without Nerd Fonts render them as tofu. Use the semantic catalog:

```ts
import { icon } from "@xynogen/pix-pretty/icon-catalog";
icon("cwd")           // resolves glyph for active mode (nerd/unicode/ascii)
```

- Keys are semantic roles (`"model"`, `"cwd"`, `"paste.image"`), never glyph names.
- `PRETTY_ICONS` env seeds the default. `/pix` switches it live (persisted to `~/.pi/agent/pix.json`).
- New icons → add to `CATALOG` in `packages/pix-runtime/src/icon-catalog.ts` with all three variants. `pix-pretty/icon-catalog` is the public re-export.
- Typed data lists use `<semantic type icon> <identifier> <type>`: icon from the catalog, identifier in `accent`, and type metadata in `muted`. Never color identifiers with raw ANSI or a fixed palette value.

### 7.2 Visual hierarchy

Pix uses color intensity to show information priority without extra UI chrome:

1. **Primary** — `toolTitle`, `accent`, status colors, and main values. Highest contrast.
2. **Secondary** — `dim`. Targets, paths, commands, descriptions, and other supporting content.
3. **Tertiary** — `muted`. Metadata, counts, timing, separators, hints, placeholders, and decorative structure. Lowest contrast.

The required ramp is **primary → dim → muted**. `dim` must be brighter than `muted` in every theme. Choose tokens by information priority, not by their names. In a row such as `<tool> <target> · <metadata>`, render the tool with `toolTitle`, the target with `dim`, and the separator plus metadata with `muted`.

Colors come from the Pi theme. Do not add a private ANSI palette to a feature package. Fallback themes (used only when no host theme reaches a component) render plain text.

### 7.3 UI surfaces

**Choose the surface by audience and lifetime. Do not pick whichever API is nearby.**

| Need | Standard surface |
|---|---|
| Tool call/result, including failures the model or transcript needs | Structured tool result + tool renderer |
| User-invoked command result, instructions, confirmation, or long actionable message | `ctx.ui.notify()` or command overlay |
| Short asynchronous background/runtime diagnostic | `showTransientMessage()` from `@xynogen/pix-pretty/transient-error` |
| Persistent live activity/progress | Named `ctx.ui.setWidget()` widget. Clear it on completion/shutdown |
| Footer state | `ctx.ui.setStatus()` or shared footer integration |
| Interactive picker/settings/form | Existing shared overlay/modal primitive, then a package-local component only if none fits |
| CLI output, browser DevTools, or explicit debug logging | `console.*`. Never let extension runtime logs write into the active TUI |

Transient diagnostics use one shared above-editor slot: one bounded line, newest wins, 30-second TTL. Levels are `error`, `warning`, and `info`. Use `showTransientError()` only as the error convenience wrapper. Do not route structured tool errors or actionable multi-line notices through this slot.

### 7.4 Tool result shape

Pix tool result renderers use one canonical completed-result shape: the unchanged body followed by a full-width, status-colored dashed close. Normal and expanded output use the same outer shape.

- Use `frameToolResult()` from `@xynogen/pix-pretty/utils`. Do not hand-build rules or duplicate frame logic.
- Successful completed results use the `success` theme role. Failed results (`isError`) use `error`.
- Do not add a top rule, `└─`, or continuation indentation to ordinary tool results.
- Keep solid rules only for intentional inner/detail sections, not outer result chrome.
- Partial/streaming output stays unframed until completion, so terminal chrome does not move.
- Auto-collapsed one-line summaries stay unframed and include a status glyph or text label, so color is not the only status signal.
- Persistent live widgets are separate surfaces: indent child rows by two spaces without tree connectors. A download-progress widget may keep one solid full-width rule above its heading. Clear completed rows after `collapse.delaySec`.
- Renderer tests assert both success and error close roles. Avoid pixel snapshots beyond stable text and semantic theme tags.

---

## 8. Tests

- Tests sit next to the code (`src/foo.test.ts`). `pix-mcp` also has `tests/`.
- Run `bun run test`. It uses `--isolate` and the preload `scripts/test-sandbox.ts` (set in `bunfig.toml`). A bare `bun test` without `--isolate` gives false failures.
- Config-dependent tests use `createIsolatedRuntime()` from `@xynogen/pix-runtime/testing`.
- Renderer tests use `@xynogen/pix-pretty/test-utils`.
- Non-trivial logic leaves one runnable check behind. A trivial one-liner needs no test.

### 8.1 Assertions — Tiger Style

Define the valid output space instead of trying to list invalid output.

- Prefer positive, canonical-shape assertions: required segments, order, separators, indentation, semantic color roles, and bounded value patterns.
- For variable formatting, measure deviation with ranges, structural parsing, or regex bounds. Do not pin a whole rendered sentence when units, rounding, width, timing, or metadata may vary.
- Use exact equality only when the exact bytes/text are the contract.
- Negative assertions are exceptional: keep them for a specific regression, omission requirement, security boundary, or mutually exclusive state. Do not make blacklist-style `not.toContain()` checks the main format test.
- One positive assertion should describe the accepted form. Do not try to reject every malformed alternative. That state space is unbounded.

---

## 9. Repo Guards

These checks keep the rules above true. They run in CI through `bun run static-analysis` and `bun run test`.

| Guard | Enforces |
|---|---|
| `biome.json` | Lint + format (tabs, width 100, no unused imports/vars, `===`, `const`). |
| `tsc -p tsconfig.base.json` | Strict types, `noUncheckedIndexedAccess`. `pix-mcp` has its own tsconfig pair. |
| `scripts/deps.test.ts` | `@xynogen/*` deps use caret ranges. No `workspace:*`, no bare `*`. |
| `scripts/binaries.test.ts` | No bare-name `spawn`/`execFile`/`pi.exec` of a catalogued binary. |
| `scripts/package-smoke.ts` | Each package tarball packs and its exports resolve. |
| `scripts/check-versions.ts` | A changed package must be ahead of npm before publish. |
| `scripts/coverage-ratchet.ts` | Coverage must not drop below the baseline. |
| `bun audit --audit-level=high` | No high-severity dependency advisories. |

---

## 10. Versions and Dependencies

### 10.1 Package independence

- Four sanctioned shared layers: `pix-runtime`, `pix-data`, `pix-pretty`, `pix-core` (aggregator). Beyond these, keep packages self-contained.
- Each package owns its own version. Bump only what changed.
- The Pi host is always a `peerDependency` (`"*"`), never a direct dep.
- Third-party deps go in the package that needs them, not hoisted to the root.
- New packages: keep zero-dep on other `pix-*` feature packages.

### 10.2 Dependency versioning

**All `@xynogen/` deps use caret ranges (`^x.y.z`).** Never `workspace:*` or bare `"*"`. These break npm publish and end-user installs.

- Set the range to `^<current version>` of the target package.
- After a **minor bump** of a shared 0.x package, update the caret range in **all consumers** (for example `pix-data` 0.3→0.4 means `"^0.3.0"` → `"^0.4.0"` everywhere). Patch bumps within the same minor need no consumer edits. Consumers whose dep range changed also need a patch bump + republish.
- A consumer that starts to use a new shared helper pins at least the version that added it.
- `publish-all.ts` aborts if `workspace:` ranges survive.

### 10.3 Bumps

- `feat` → minor, `fix`/`perf` → patch, breaking → major.
- **Patch bumps only by default.** Minor/major need explicit user approval.
- A package already ahead of npm (unpublished bump) needs no second bump for more changes before release.
- After you bump a bundled package, update its pin in `packages/pix-core/package.json`.

---

## 11. Development and Commits

```bash
bun install                # install deps
bun run dev:link           # symlink into Pi (restart Pi after)
bun run dev:unlink         # restore npm copies
bun run check              # biome lint + format
bun run check:fix          # auto-fix
bun run typecheck          # tsc --noEmit
bun run test               # unit tests (--isolate + sandbox preload)
bun run graph:build        # refresh .pi/graph/graph.json
```

Commit format: `type(scope): short description`. The scope is the package name, for example `fix(pix-core): ...`.

Types: **feat** (new capability) · **fix** (bug fix) · **refactor** (no behavior change) · **chore** (deps/config/tooling) · **docs** (documentation).

Always run `bun run check` + `bun run typecheck` before you commit. CI fails otherwise.

---

## 12. CI / CD

CI runs `bun run static-analysis` → `bun run test` → coverage ratchet on every push to `main` and on PRs. CD starts only on a `release-YYYYMMDD-HHMM` tag push.

When the user says "publish", read [`docs/release.md`](docs/release.md) and follow its runbook exactly.

---

## 13. Key Rules

- Run `bun run check` + `bun run typecheck` before you commit.
- Never tag without bumping versions. Publish skips already-published versions.
- Patch bumps only by default. Minor/major need explicit user approval.
- Search the shared layers (section 3) before you write a helper. Delete copies when you share one.
- Import other packages only through public `exports` (section 5).
- Paths through `pix-runtime/paths`, binaries through `pix-runtime/exec`, network timeouts through `pix-runtime/io`.
- Colors from the theme, icons from the catalog, result frames from `frameToolResult`.
- No `/toolbox` in agent-facing text. It is a user slash command, not model-callable.
- Scripts are idempotent. The shared tsconfig is `tsconfig.base.json`.
