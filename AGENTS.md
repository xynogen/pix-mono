<!-- markdownlint-disable MD013 MD040 MD060 -->

# pix-mono — Agent Operating Guide

Monorepo of Pi Coding Agent extensions (`@xynogen/pix-*`).
**Bun** runtime · **Biome** lint/format · **tsc** types · **bun run test** tests · all ESM (`"type": "module"`, ES2022).

---

## Product Design Philosophy

Pix is a **transparent, token-efficient, model-flexible** Pi distro. These are product constraints, not optional preferences. Apply them when designing, implementing, or reviewing every feature.

### 1. Minimize token use

- Keep the baseline system prompt and recurring tool schemas small.
- Load skills, instructions, model catalogs, and volatile metadata only on demand.
- Prefer targeted reads, bounded previews, compact structured results, and edit formats that reduce retries.
- Inject prompts only when the current task needs them; avoid passive or always-on context.
- UI collapse may reduce visual clutter, but the complete result must remain expandable and available to the user and agent.
- Measure token savings where possible. Do not make unverified efficiency claims.
- Avoid always-on advisors, reviewers, background loops, verbose orchestration transcripts, and giant all-purpose tool schemas.

### 2. Preserve strong model flexibility

- The user or calling agent chooses the model for each task.
- Pix may display benchmark scores, context size, price, capabilities, and recommendations, but must not silently pin or route to a model/provider.
- Subagents inherit the parent model when omitted or use the caller's explicit `model`; an agent type/persona must not override that choice.
- Any fallback or model change must be visible and report the reason, previous model, replacement model, and relevant cost/capability difference.
- Prefer provider-neutral interfaces and avoid features that create provider lock-in.

### 3. Keep agent behavior visible

- Every meaningful read, command, edit, delegation, approval, retry, and result must appear in the transcript or live UI.
- Show subagent identity, selected model, scope, current activity, token/cost information when available, and final output.
- Show file changes as inspectable diffs and findings with paths/evidence.
- Users must be able to inspect, expand, steer, stop, approve, reject, or undo work where the operation permits it.
- Never discard details merely because a card is collapsed; collapsing is presentation, not concealment.
- Memory, if added, must be explicit and auditable: visible retain/recall operations, provenance, injected-token estimate, and list/edit/delete controls.

### 4. Prefer composability over magic

- Build complex behavior from ordinary, visible tools and subagents.
- Convenience UI may prepare, organize, or summarize a workflow, but must not conceal its plan, model routing, tool calls, retries, edits, or review steps.
- Avoid any opaque high-level command, shortcut, trigger, or mode that silently launches planning, routing, tool use, retries, edits, delegation, or background automation. A `/goal`-style command or magic word is only one example of this broader anti-pattern.
- Reviews must be explicitly invoked and show reviewer models, scopes, token use, evidence, deduplication, and verdict construction; do not run an always-on reviewer by default.

### Feature review checklist

Before accepting a feature, answer:

1. Does it reduce or unnecessarily add baseline/context/output tokens?
2. Can the user choose the model and provider without a hidden override?
3. Can the user see what ran, why it ran, what it read or changed, and what it cost?
4. Can the user inspect, steer, stop, approve, reject, or undo it where applicable?
5. Is it composed from visible primitives rather than opaque automation?
6. Is a sensitive, expensive, or setup-heavy capability opt-in instead of bundled by default?

Product promise: **No hidden intent. No silent routing. No blind automation.**

---

## Repo Structure

```
packages/
  # ── Aggregator ─────────────────────────────────────────────────────
  pix-core/        # Meta-package — bundles + activates the core distro
  # ── Shared layers ──────────────────────────────────────────────────
  pix-data/        # Model data (modelgrep + BenchLM, cached at ~/.cache/pi)
  pix-runtime/     # pix.json config runtime (sections, atomic writes, /pix command), once() guard, collapse policy
  pix-pretty/      # Rendering lib (highlight, diff, icons, fff, widget-format, modal-frame) + FFF slash commands
  pix-themes/      # Theme pack — 7 dark themes
  # ── UI / UX (bundled by pix-core) ─────────────────────────────────
  pix-welcome/     # ASCII π banner + startup health checks
  pix-footer/      # Status bar — mode, git, model, tokens, cost, TPS
  pix-models/      # /models — model picker (score, context, cost)
  pix-update/      # /update — self-update Pi + extensions
  pix-commands/    # /clear cache + /btw isolated concurrent side questions
  pix-nudge/       # Tools + capability nudge
  pix-diagnostics/ # Compact session-files widget
  pix-display/     # Paste chip rendering + leaked <think> cleanup
  pix-prompts/     # System-prompt injection (AGENT.md + repo directive scan)
  pix-skills/      # Skill loader (read_skills tool + bundled skills)
  # ── Behaviour (bundled by pix-core) ────────────────────────────────
  pix-optimizer/   # Caveman + RTK + TOON + ponytail (/optimizer)
  pix-gate/        # Permission gate for dangerous commands
  pix-subagent/    # Sub-agent spawning (agent / agent_result / agent_steer)
  # ── Tool suite (bundled by pix-core — Pi built-in replacements) ───
  pix-bash/  pix-read/  pix-write/  pix-edit/
  pix-find/  pix-grep/  pix-ls/    pix-ask/
  pix-todo/        # Durable execution checklist (survives context compaction)
  # ── Standalone (opt-in, NOT bundled) ───────────────────────────────
  pix-9router/     # 9Router LLM provider + fetch/search/transcribe (needs API key)
  pix-sudo/        # sudo_run with PAM password prompt
  pix-ssh/         # ssh_run — remote command over SSH (key/password auth + remote sudo)
  pix-toolbox/     # Gated tool toggle UI (/toolbox)
  pix-graph/       # Native-TS code knowledge graph — `graph` tool (build/query) + CLI + library, no Python
  pix-mcp/         # Token-efficient MCP gateway (external servers; explicit opt-in)
scripts/
  dev-link.sh      # Symlink packages into Pi for dev
  publish-all.ts   # Publish changed packages to npm (idempotent)
  install.sh       # Install all packages into Pi
  deps.test.ts     # CI dep-hygiene checks (workspace:*, bare *, caret ranges)
.github/workflows/
  ci.yml           # Lint + typecheck + test on push/PR
  publish.yml      # Publish to npm on release tag
```

---

## Development

```bash
bun install                # install deps
bun run dev:link           # symlink into Pi (restart Pi after)
bun run dev:unlink         # restore npm copies
bun run check              # biome lint + format
bun run check:fix          # auto-fix
bun run typecheck          # tsc --noEmit
bun run test               # unit tests
```

---

## Commits

Format: `type(scope): short description` — scope = package name, e.g. `fix(pix-core): ...`

Types: **feat** (new capability) · **fix** (bug fix) · **refactor** (no behavior change) · **chore** (deps/config/tooling) · **docs** (documentation)

---

## CI / CD

**CI** runs on every push to `main` and PRs: biome ci → tsc → bun run test.

**CD** is triggered by a release tag push (`release-YYYYMMDD-HHMM`), never by a direct branch push.

```bash
# Bump version(s), commit, push to main, wait for CI green, then:
TAG="release-$(date +%Y%m%d-%H%M)" && git tag "$TAG" && git push origin "$TAG"
```

The Publish workflow triggers **on the tag push itself** (`on: push: tags: release-[0-9]*`). Its first step polls the Actions API and **requires a green CI run on that exact commit** before publishing — it does not re-run the suite. A tag pushed while CI is still running waits (up to ~10 min) instead of failing; a failed/cancelled CI aborts the publish. It then checks each `name@version` against npm and publishes only new versions (idempotent, OIDC trusted publishing — no NPM_TOKEN needed). Dry-run locally: `bun run publish:dry`.

Because the tag is the trigger (not CI-completion), there is **no tag-push race** and no manual dispatch needed. `workflow_dispatch` remains only as a break-glass fallback that publishes from the `main` tip (still gated on that commit's CI being green).

### Agent runbook — "publish"

"publish" (alone) means: run this exact sequence, no re-asking which packages.

1. **Approve once, up front** — inspect release scope, then use `ask_user` once. Approval prompt must show:
   - current branch and target commit SHA;
   - dirty files and proposed commit message, or state that no commit is needed;
   - commits included since the previous release tag;
   - exact package/version list planned for npm;
   - target release tag (`release-YYYYMMDD-HHMM`);
   - remote effects: commit push if needed, push to `main`, tag push, Publish workflow trigger, and npm publication.

   Approval covers the complete listed release. Do not ask again unless target commit, tag, or package/version list changes after approval.
2. **Gate** — `bun run check && bun run typecheck && bun run test`. Red → STOP.
3. **Confirm bumps** — changed packages must have version ahead of npm. Unbumped → that package silently ships nothing (no error). Semver: `feat`→minor, `fix`/`perf`→patch, breaking→major.
4. **Dry-run** — `bun run publish:dry` — note the exact `name@version` list. If it differs from the approved list, STOP and request new approval.
5. **Push commits + wait for CI** — push to `main`, then `gh run watch <ci-run-id> --exit-status` for the branch CI on the pushed SHA. CI must be green *before* tagging (the Publish gate requires it). Red → STOP.
6. **Tag + push** — create and push the release tag without another approval. This directly triggers the Publish workflow; no manual dispatch. The Publish job re-confirms CI is green on the tagged commit, then publishes.
7. **Verify GitHub Actions** — find the triggered Publish run (`gh run list --workflow Publish --limit 1`) and `gh run watch <run-id> --exit-status`. Confirm its log reports every expected `name@version` as published and ends with `0 failed`; report the Publish workflow URL and exact published versions. Red → STOP and report the failing step/log — never claim the release succeeded from the tag push alone. (If the tag push ever fails to trigger Publish, the fallback is `gh workflow run Publish --ref main`.)

---

## Package Independence

- **Four sanctioned shared layers:** `pix-runtime` (config + once + collapse), `pix-data` (model data), `pix-pretty` (rendering), `pix-core` (aggregator). Beyond these, keep packages self-contained.
- Prefer duplicating small utilities over adding a cross-package dep.
- Each package owns its own version — bump only what changed.
- Pi host is always a `peerDependency`, never a direct dep.
- Third-party deps go in the package that needs them, not hoisted to root.

---

## Dependency Versioning

**All `@xynogen/` deps must use caret ranges (`^x.y.z`).** Never `workspace:*` or bare `"*"` — these break npm publish and end-user installs.

- Set range to `^<current version>` of the target package.
- After a **minor bump** of a shared 0.x package, update the caret range in **all consumers** (e.g. `pix-data` 0.3→0.4 means `"^0.3.0"` → `"^0.4.0"` everywhere). Patch bumps within the same minor need no consumer edits (`^0.3.0` already matches `0.3.1`). Consumers whose dep range changed also need a patch bump + republish.
- `publish-all.ts` aborts if `workspace:` ranges survive.
- CI enforces via `scripts/deps.test.ts`: no `workspace:`, no bare `*`, all `@xynogen/` deps use `^`.

---

## Icon Catalog

**Never hardcode Nerd Font glyph codepoints** (terminals without Nerd Fonts render them as tofu). Use the semantic catalog in `pix-pretty`:

```ts
import { icon } from "@xynogen/pix-pretty/icon-catalog";
icon("cwd")           // resolves glyph for active mode (nerd/unicode/ascii)
```

- Keys are semantic roles (`"model"`, `"cwd"`, `"paste.image"`), never glyph names.
- `PRETTY_ICONS` env seeds default; `/pix` settings command switches live (persisted to `~/.pi/agent/pix.json`).
- New icons → add to `CATALOG` in `packages/pix-pretty/src/icon-catalog.ts` with all three variants.

---

## UI Visual Hierarchy

Pix uses color intensity to show information priority without adding UI chrome:

1. **Primary** — `toolTitle`, `accent`, status colors, and main values. Highest contrast.
2. **Secondary** — `dim`. Targets, paths, commands, descriptions, and other supporting content.
3. **Tertiary** — `muted`. Metadata, counts, timing, separators, hints, placeholders, and decorative structure. Lowest contrast.

The required visual ramp is **primary → dim → muted**. `dim` must be brighter than `muted` in every theme. Do not choose these tokens by their conventional names; choose them by information priority. In a row such as `<tool> <target> · <metadata>`, render the tool with `toolTitle`, the target with `dim`, and the separator plus metadata with `muted`.

---

## Shared Rendering & Widget Helpers

**pix-pretty is the home for any rendering, layout, or display-formatting code shared by two or more packages.** It is a sanctioned shared layer, so extracting into it never breaks the Package Independence rule.

This refines — it does not contradict — "prefer duplicating small utilities over adding a cross-package dep":

- **One-off, package-local helper** (a bespoke summary line, a single-use parser) → keep it local; do not reach for pix-pretty.
- **The same rendering/formatting/UI surface appears in ≥2 packages** (or you're about to copy one in) → extract it into pix-pretty and import from there. Do not leave parallel copies that drift.

Before writing a new formatter, spinner, token/duration/byte formatter, activity/status line, modal, overlay, or widget layout, **grep pix-pretty first** — the primitive may already exist:

```ts
import { SPINNER, formatMs, formatTokens, fmtTokenCount, formatContext,
         formatTurns, formatToolUses, formatSpeed, describeActivity,
         getSessionContextUsage } from "@xynogen/pix-pretty/widget-format";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { frameLines, modalWidth } from "@xynogen/pix-pretty/modal-frame";
import { showOverlay } from "@xynogen/pix-pretty/gate-overlay";
```

- `widget-format` — live-widget helpers: `SPINNER` (braille frames), token/duration formatters, `describeActivity`, session-stats readers. Shared by pix-subagent's agent widget and pix-commands' `/btw` widget.
- `modal-frame` — rounded-border overlay primitives (`frameLines`, `modalWidth`). Used by pix-ask, pix-mcp, pix-models, pix-optimizer.
- `gate-overlay` — the permission/confirm dialog (pix-gate, pix-sudo).
- `icon-catalog` — semantic glyph table (never hardcode codepoints). Includes the `status.*` family (`status.ok/error/warn/pending/running/active/done/blocked`, all three modes) for checklists, panels, and finished-line markers; nerd/unicode keep the historical literal so mixed rows stay aligned, ascii mode is tofu-free.
- `utils` — `humanSize(bytes)` renders IEC units (`B`/`KiB`/`MiB`/`GiB`, 1024-based). Token *counts* use `fmtTokenCount` in `widget-format` (plain `K`/`M`, no `iB`) — different formatter, do not conflate.
- `diff`/`diff-render`, `highlight`, `renderers`, `fff`, `ansi` — see the full export map in `packages/pix-pretty/README.md`.

Adding a helper to pix-pretty is a public-API addition → **minor bump** (needs approval per Key Rules). Consumers on `^1.x` carets already match a new minor, so no range edits ripple; only the packages you actually rewire (plus their pix-core pins) need patch bumps. New shared helpers must be pure and Pi-host-agnostic (accept a minimal `Theme`/`SessionLike` shape, not the full `ExtensionAPI`), and ship with unit tests in pix-pretty.

---

## Unified Config — `~/.pi/agent/pix.json`

Owned by `pix-runtime` (init/reload/flush + the `/pix` settings command). Auto-created with defaults on first session. Sections:

| Section | Consumers |
|---|---|
| `collapse` | pix-bash, pix-read, pix-grep, pix-edit, pix-write, pix-find, pix-ls, pix-todo, pix-sudo, pix-ssh, pix-skills, pix-subagent, pix-9router |
| `pretty` | pix-pretty (icons, preview/render limits, diff split thresholds) |
| `optimizer` | pix-optimizer (caveman/rtk/ponytail state) |
| `gate` | pix-gate (rules, auto-approve patterns) |

Loader: `@xynogen/pix-runtime/config` (sections in `@xynogen/pix-runtime/sections`) · Collapse: `@xynogen/pix-runtime/collapse`. Full schema in `packages/pix-runtime/README.md`.

---

## Key Rules

- **Always run `bun run check` + `bun run typecheck` before committing** — CI will fail otherwise.
- **Never tag without bumping versions** — publish skips already-published versions.
- **Patch bumps only by default.** Minor/major require explicit user approval.
- **No `/toolbox` in agent-facing text** — it's a user slash command, not model-callable.
- Scripts are idempotent. Shared tsconfig: `tsconfig.base.json` — each package extends it.
- New packages: keep zero-dep on other `pix-*` packages if at all possible.
