# pix-sec — Design Doc

**Date:** 2026-08-25
**Status:** Approved for planning
**Scope:** New package `@xynogen/pix-sec` — security auditing capability for Pi/Pix. Multi-agent, graph-traversal-driven code auditing with a durable, kanban-style findings store.

---

## 1. Goal

A **transparent, token-efficient, model-flexible** security-audit capability composed from Pix primitives — the open-source-spirit answer to a Hacktron-like platform, built as ordinary visible tools + subagents, not opaque automation.

Concretely: the agent can **scan** a codebase with real SAST engines, build a **security code graph**, traverse that graph to split work by **attack path** (not by folder), and record results in a **durable, per-project findings store** that survives sessions and renders as a **kanban board**.

**Testing scope only** — targets are the user's own code and deliberately-vulnerable local apps (DVWA, juice-shop). No live/unauthorized targets, no auto-exploit.

---

## 2. Design constraints (from AGENTS.md)

- **Minimize tokens** — small tool schemas; skills off-context until loaded; graph slices sent to workers, not whole folders.
- **Model flexibility** — subagents inherit parent model or use caller's explicit `model`; auditor personas never pin a model.
- **Visibility** — every scan, graph build, subagent spawn, and finding move is a visible tool call / widget row.
- **Composability** — capability = 3 small tools; strategy = thin skills that sequence them. No magic command, no always-on scanner.

---

## 3. Architecture

```
pix-sec/
├── src/
│   ├── scan.ts       → `scan` tool     — run SAST engines, normalize → findings
│   ├── findings.ts   → `findings` tool — durable store + kanban board render
│   ├── graph.ts      → `graph` tool    — build/query security code graph + staleness
│   ├── engines.ts    → scanner registry (engine → argv + parser)
│   └── index.ts      → registers the 3 tools (once() guarded)
└── skills/           → strategy layer (off-context, loadable via read_skills)
    ├── sec-orchestrator.md   → path-based fan-out recipe
    ├── injection-auditor.md
    ├── authz-auditor.md
    ├── secrets-auditor.md
    ├── taint-auditor.md
    ├── ssrf-auditor.md
    ├── idor-auditor.md
    └── sec-report.md         → dedup + normalize + export
```

**Tools = capability** (always callable, typed, deterministic parsing).
**Skills = strategy** (how to sequence tools; off-context by default per pix-skills pattern). A full audit is possible with **zero skills loaded** — just `scan` → `graph` → `findings`.

### State — all in `.pi/pix-sec/` (per-project, survives sessions, travels with repo)

| File | Contents |
|---|---|
| `findings.json` | findings + lifecycle status |
| `graph.json` | nodes + edges |
| `graph.manifest.json` | git blob SHAs (fallback: mtime+sha), `builtAt`, engine versions |

Durable-across-*compaction*: mirror pix-todo — disk is source of truth, `appendEntry` replay rehydrates the in-context view after compaction. Atomic writes via runtime write helpers.

---

## 4. Tool: `scan`

Runs SAST engines behind one small schema; normalizes all output into the findings store.

```
scan(engine, target?, ruleset?)
  engine   enum: "semgrep" | "gitleaks" | "osv" | "bandit" | "gosec" | "brakeman" | ...
  target   path (default: cwd)
  ruleset  optional engine-specific rule pack
→ { added: N, byEngine: {...}, skipped?: {engine, install} }
```

- **Engine registry** (`engines.ts`, internal — not in schema): `engine → { cmd, parse, langs|kind }`. Adding a scanner = one registry entry + one parser. Zero new schema, zero prompt cost. **Composability win.**
- **Tiering** (guidance in the orchestrator skill, not enforced in the tool):
  - Tier 1 (broad): semgrep/opengrep + gitleaks + osv-scanner.
  - Tier 2 (language-triggered): bandit (py), gosec (go), brakeman (ruby), njsscan (node), etc.
  - Tier 3 (opt-in, heavy): CodeQL, trivy IaC — v2+.
- **Missing binary** → `{skipped: {engine, install}}`, never crash. Agent adapts.
- **Auto-writes findings** with `status:"new"`. Agent triages after via `findings`. ("scanners dumb, agent smart.")
- **Normalization** → prefer parsing each engine's **SARIF** output where available (semgrep, others speak it); common finding shape internally.

**Execution:** blocking for v1 (semgrep on a mid repo is seconds). `ponytail:` background-handle mode (like pix-subagent) is the upgrade path if big-repo scans block too long.

---

## 5. Tool: `findings` (kanban)

Durable store. Lifecycle states **are** kanban columns.

```
findings(action, ...)
  add     {class, severity, path, line, evidence, fix}   → status:"new"
  list    filter by status|severity|class
  update  id, status|fix|notes                            (status change = "move card")
  move    id, to:<status>                                 (alias of update status — reads as kanban)
  dedup   merge same-location same-class
  board   render kanban view (grouped by status)
  export  → markdown report
```

**Columns (lifecycle):** `new → triaged → confirmed → false-positive → fixed`.
Plus `regression` reachable from `fixed` (re-check next session found it again) — the stateful "platform" behavior vs. a chatbot.

**Board render** (`findings board`) — read-only view in pix-pretty:

- **Width-responsive:** horizontal columns when terminal ≥120 cols; stacked full-width sections below that (narrow terminals show real `file:line` evidence instead of truncated cards).
- Reuses `modal-frame`, `status.*` icons, severity colors already in pix-pretty. No data-model change — pure view over `status`.
- `ponytail:` interactive overlay (arrow-key navigate, keybind to move cards, like /toolbox) is the upgrade path; v1 is read-only render.

**Dedup ownership:** auditors emit raw findings; the `sec-report` skill (or `findings dedup`) is the sole normalizer/deduper. Auditors dumb, report smart — avoids semantic-dupe drift across parallel workers.

---

## 6. Tool: `graph` (security code graph + traversal)

Not folder structure — the **attack-surface graph**.

**Nodes:** functions, routes/handlers, sources (params, body, headers, env, file reads), sinks (query exec, `eval`/`exec`, fs ops, template render, outbound HTTP), auth checks.
**Edges:** `calls`, `imports`, `data-flows-to`, `guarded-by` (auth), `reaches` (source→sink).

The killer query: **sources that reach sinks without passing an auth check** — the pentest question folder-splitting can't answer.

```
graph(action, ...)
  build      → extract graph, write manifest
  status     → staleness check {fresh|stale, changed:[files], builtAt}
  query      → e.g. "unguarded source→sink paths", "callers of authMiddleware"
  path       → shortest source→sink path (PoC skeleton)
  neighbors  → node's edges (subagent context expansion)
```

### Source (v1 — chosen)

- **Structure** from **LSP call-hierarchy** (pi-lens) — `callHierarchy` + `references`. Semantically accurate, free, already installed. Owns: calls, imports, route/auth structure.
- **Dataflow/taint** from **semgrep** (`--dataflow-traces`). Its taint output **is** source→sink paths. Owns: `data-flows-to`, `reaches`.
- **We do NOT reimplement taint.** semgrep owns dataflow; we own call/route/auth structure and stitch the two into one graph.
- `ponytail:` ast-grep source/sink tagging rules are the v2 upgrade if LSP+semgrep prove too coarse. CodeQL is Tier-3 opt-in.

### Staleness (cheap check — chosen)

- **Primary (git repo):** store `git ls-files -s` blob SHAs at build → diff on `status`. Git already content-hashed every file → zero hashing on our side, byte-exact. Stale iff a changed file has nodes in the graph.
- **Fallback (non-git/dirty):** mtime+size gate → sha only the suspects.
- **Surfaced as a `stale` flag** on every read-path result (`query`/`path`/`neighbors`), **never auto-rebuild** (rebuild is expensive; hiding it violates visibility). `status` is the explicit "is it current?" call.
- `ponytail:` file-granular via git blob SHA — reformatting a file flags it stale though no node changed. Upgrade: hash per-node AST subtrees (tree-sitter) for false-staleness-free, and free incremental rebuild targets.

---

## 7. Traversal-as-work-splitter (the differentiator)

Orchestrator splits work **by attack path**, not by folder:

```
sec-orchestrator skill:
  1. scan(semgrep) + scan(gitleaks) + scan(osv)      → seed findings (deterministic, cheap)
  2. graph.build                                       → LSP structure + semgrep taint
  3. graph.query "unguarded source→sink paths"        → N candidate attack paths
  4. for each path (or sink cluster):
       agent(type:"Explore", model:<caller-picked>,
             prompt:"confirm/refute taint path: <slice>",
             allowed_tools:[read,grep,graph,findings])
       worker: graph.neighbors to expand its slice → findings.add
  5. sec-report: findings.dedup → findings.export
```

Each worker receives a **subgraph slice** (path + neighborhood), not a directory — better signal, far better token economy. Fan-out is visible in the pix-subagent widget. Model stays caller-chosen.

---

## 8. Deliberately NOT built (YAGNI)

| Skipped | Why | Upgrade path |
|---|---|---|
| Real sandbox (firecracker/gVisor) | testing scope; pix-gate + local containers suffice | v2 if untrusted targets |
| PoC auto-exploit validation | highest legal/safety risk | never for unauthorized scope |
| Custom graph UI | subagent widget already shows fan-out; board covers findings | interactive overlay later |
| Persistent repo index | LSP + grep index on demand | — |
| ast-grep source/sink rules | LSP+semgrep cover v1 | v2 if too coarse |
| CodeQL | heavy DB build, license limits | Tier-3 opt-in |
| Background scan handles | v1 blocking is fine for mid repos | if big-repo scans block |
| Interactive kanban overlay | read-only render is a fraction of code | if hand-driving cards wanted |

---

## 9. Testing strategy

- **Unit** (bun test, in-package): engine registry parser tests (feed captured SARIF/gitleaks/osv JSON fixtures → assert normalized findings); findings store lifecycle + dedup + staleness (git-blob-SHA diff on a temp repo); board render snapshot (wide + narrow).
- **Integration (manual, testing scope):** run full loop against local juice-shop / DVWA; verify graph paths, worker fan-out, kanban states.
- Follow repo gate: `bun run check && bun run typecheck && bun run test` green before any commit.

---

## 10. Package / release notes

- New package `@xynogen/pix-sec`. Peer-deps Pi host. Uses sanctioned shared layers: `pix-runtime` (config/collapse/once, `.pi/` writes), `pix-pretty` (board render, icons, modal-frame), `pix-subagent` capability (via host tools), pi-lens LSP.
- Board renderer is shared UI → lives in `pix-pretty` (grep first; extract if any helper already exists). Public-API addition to pix-pretty = **minor bump** (needs approval).
- **Standalone, opt-in — NOT bundled by pix-core** (semgrep/gitleaks/osv are external binaries; security tooling is opt-in per the feature checklist).
- All `@xynogen/` deps use caret ranges.

---

## 11. Open items resolved

| Question | Decision |
|---|---|
| Findings store location | `.pi/pix-sec/` (per-project, survives sessions) |
| Analysis engine | wrap Semgrep (+ registry for more), not grep-only |
| v1 auditor scope | all 6 auditors + orchestrator + report |
| AI calls it how | first-class **tools** (scan/findings/graph), skills are optional strategy |
| Graph source v1 | LSP call-hierarchy + semgrep taint (no ast-grep rules yet) |
| Taint ownership | semgrep owns dataflow; we own call/route/auth structure |
| Staleness | cheap git-blob-SHA diff → mtime fallback; flag not auto-rebuild |
| Findings view | kanban — lifecycle = columns; read-only width-responsive board |

---

## 12. Next step

Invoke `/plan` to turn this into a bite-sized implementation plan. Do not start coding directly.
