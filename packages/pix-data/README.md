# pix-data

Pi coding agent extension — shared model data layer. Warms two cached
data sources on session start so other extensions (model picker, footer,
subagent resolver) can read context window, pricing, and a coding-focused
score/rank synchronously without redundant network calls:

- **[modelgrep](https://modelgrep.com)** — the model catalog (context window,
  pricing, modalities, capabilities, raw benchmark fields) used as the
  authoritative source when present.
- **[benchlm.ai](https://benchlm.ai)** — a leaderboard of 0–100 coding scores
  used as a fallback when modelgrep's `artificial_analysis` block is null
  (currently the common case for the long tail of models).

Both caches live under `~/.cache/pi/` and are shared across every Pi
extension using the same `DataSource` class — whichever extension loads
first populates the cache; subsequent extensions read from disk.

## Data sources

- **`modelgrep`** — `GET /api/v1/models?sort=coding&order=desc&limit=200`,
  paginated up to 10 pages (`meta.has_more` / `next_offset`). Free, no API key.
  modelgrep aggregates benchmark numbers from
  [Artificial Analysis](https://artificialanalysis.ai). Context window, pricing,
  and modalities are taken verbatim from the catalog.
- **`benchlm`** — `GET https://benchlm.ai/api/data/leaderboard`. Free, no API
  key. Each entry has an `overallScore` (0–100) used as the fallback score
  when modelgrep's `artificial_analysis` block is null.

Cache files:

- `~/.cache/pi/modelgrep.json` (TTL 24h)
- `~/.cache/pi/benchlm.json` (TTL 24h)

On outage the stale cache keeps the picker working until it can refresh.

## Scoring methodology

The score a model receives is the first of the following that succeeds, in
order:

1. **Primary = [Artificial Analysis Intelligence Index](https://artificialanalysis.ai/methodology/intelligence-benchmarking)**
   when present on the modelgrep entry — AA's authoritative composite of 9
   independent evals (agents, coding, scientific reasoning, general), already
   weighted toward agentic work. Rescaled to 0–100
   (`intelligence / 65 × 100`; the current leader scores ~65).
2. **Heuristic** from modelgrep's raw benchmark fields when the AA index is
   absent. Weighted blend of the same family of evals AA uses, then mapped onto
   the index scale by a least-squares line. Both the heuristic weights *and*
   the line were jointly tuned against the index on the models that carry
   *both* it and the raw benches (`index100 ≈ 120.6·heuristic − 10.6`, deduped
   n=29, R²=0.901, leave-one-out RMSE 6.55pt) — a data calibration, not a
   guessed penalty. The picker exists to choose a model *for coding work in an
   agent*, so the heuristic is weighted toward exactly that:

| bench | range | measures |
|---|---|---|
| `coding` | 0–100 | code generation index |
| `scicode` | 0–1 | scientific coding |
| `tau2` | 0–1 | agentic tool-use |
| `agentic` | 0–100 | agentic index |
| `gpqa` | 0–1 | graduate-level reasoning |
| `hle` | 0–1 | hard-exam reasoning |

When the index is absent, three sub-scores combine, each a weighted blend of
its benches (all normalized to 0–1):

```
coding_score    = 0.60·(coding/100) + 0.40·scicode
agentic_score   = 0.70·tau2         + 0.30·(agentic/100)
reasoning_score = 0.60·gpqa         + 0.40·hle

heuristic = 0.30·coding_score + 0.60·agentic_score + 0.10·reasoning_score
score     = round(clamp₀₁₀₀(120.6·heuristic − 10.6))   // fitted to the index
```

1. **benchlm.ai fallback** — if the model exists in benchlm but modelgrep has
   no AA index and no raw benches, look up the benchlm `overallScore` (0–100)
   and use it verbatim. Match strategy (in `lookupBenchlmScore`): exact
   normalized slug, then prefix overlap either way, then take the
   highest-scoring match on a tie.

**Why a heuristic at all, and why these raw evals only:** the AA Intelligence
Index *is* the ideal number — but only ~16% of the catalog has it. For the rest
we rebuild a comparable score from the same family of raw evals. Crucially we
use each raw eval **once** and never feed `intelligence` *and* its components
together, nor any `_pct` field (which is just a percentile-rank of a raw field)
— doing so would double-count the same measurement and silently inflate weights
you can't see. Independent inputs only → honest weighted average.

**Why these weights:** an agentic coding model lives or dies on *tool-calling*
and *code generation*, so `agentic_score` (0.60) and `coding_score` (0.30)
carry the score; pure reasoning (0.10) is a tiebreaker, not the headline. The
split is not arbitrary — a grid search over weight combinations, scored by how
well the heuristic predicts the AA index (leave-one-out cross-validation),
landed on this agentic-heavy mix. Within each group the dominant bench (`tau2`
for agentic, raw `coding`, `gpqa`) carries most of the weight and a secondary
bench refines it.

**Missing benchmarks:** every blend renormalizes over the fields actually
present, so a model missing one bench is diluted only *within its own group* —
it is never zero-penalized or dropped. A model with no benchmarks at all gets a
`null` score (shown as a bare row) and sorts to the bottom.

The exact implementation is `codingScore()` in
[`src/data.ts`](src/data.ts); the weights are intentionally easy to tune in one
place if your priorities differ.

## What's included

| Export | Description |
|---|---|
| `modelgrep` | `DataSource<ModelGrepModel[]>` — the modelgrep catalog. TTL 24h → `~/.cache/pi/modelgrep.json` |
| `benchlm` | `DataSource<BenchLMRawEntry[]>` — the benchlm.ai leaderboard (fallback scores). TTL 24h → `~/.cache/pi/benchlm.json` |
| `DataSource` | Generic cached data source class |
| `CACHE_DIR` | Resolved cache directory (`~/.cache/pi`) |
| `buildModelsDevIndex` | Build a lookup `Map` from the catalog (context/cost/modalities) |
| `fetchModelsDevIndex` | Fetch the catalog and build the lookup index in one call |
| `lookupInIndex` | Fuzzy-match a router model id against an index |
| `lookupModelsDev` | Sync lookup by id from in-memory cache (joined on slug) |
| `lookupBenchmark` | Sync lookup a model by id — returns score + rank + pricing |
| `benchScoreColor` | Map a 0–100 score to a `success`/`warning`/`error`/`muted` token |

## Unified config + collapse — now in `pix-runtime`

The shared `~/.pi/agent/pix.json` config loader and the auto-collapse state
machine used to live here. They now live in
[`@xynogen/pix-runtime`](https://github.com/xynogen/pix-mono/tree/main/packages/pix-runtime):

- Config: `@xynogen/pix-runtime/config` (sections in `@xynogen/pix-runtime/sections`)
- Collapse: `@xynogen/pix-runtime/collapse`
- The `/pix` settings command and config APIs are documented in `pix-runtime`'s
  README.

pix-data no longer exports `pixConfig`, `reloadPixConfig`, `shouldCollapse`,
`collapseDelayMs`, or `tickCollapse` — update any imports to `pix-runtime`.

## Install

```bash
pi install npm:@xynogen/pix-data
```

## How it works

On session start the extension fires two non-blocking fetches in parallel
(`modelgrep.get()` and `benchlm.get()`) — Pi session start is not gated on
either. If the cache is fresh both fetches are skipped. The cache files live
in `~/.cache/pi/` — any Pi extension using the same `DataSource` shares them
automatically.

## Full distro

Source: [github.com/xynogen/pix-mono](https://github.com/xynogen/pix-mono)

To install the complete pix suite (all packages + Pi itself):

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

## License

MIT
