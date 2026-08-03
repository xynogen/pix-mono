# `@xynogen/pix-runtime` design

Status: proposed  
Target first release: `0.1.0`

## 1. Purpose

`pix-runtime` is Pix's small shared runtime layer. It owns the process-wide Pix
configuration contract and the lifecycle needed to keep that contract coherent.
It is **not** an aggregator, renderer, model-data package, service locator, or
state database.

Its first responsibility is to make `~/.pi/agent/pix.json` the single, sparse,
versioned user configuration file for the Pix distro. It will own:

- the config schema and defaults;
- validation and normalization;
- one-time migrations, including `optimizer.json`;
- atomic persistence and serialized writes;
- an immutable in-process config snapshot;
- typed change events with changed paths and origin;
- lifecycle initialization and shutdown;
- the `/pix` shared-settings command;
- narrow, pure runtime helpers such as collapse policy.

Package boundaries after adoption:

- `pix-core`: dependency aggregation and extension registration only;
- `pix-runtime`: shared configuration and lifecycle;
- `pix-data`: model catalogs, scores, and caches only;
- `pix-pretty`: rendering only; consumes runtime settings;
- feature packages: own behavior and UI, and consume built-in typed runtime
  sections where shared persistence is appropriate.

## 2. Non-goals

The runtime must not become a general dependency-injection container.
Specifically, v1 does not own:

- themes, ANSI values, render caches, or TUI components;
- model catalogs or network cache refreshes;
- session transcript state, todos, tool results, or credentials;
- arbitrary package services;
- project-local Pix configuration;
- automatic filesystem watching;
- hidden background work or package activation.

There is one runtime instance per JavaScript process, not one per conversation.
The singleton is stored under `globalThis[Symbol.for("@xynogen/pix-runtime")]`, not
only in module scope, so duplicated compatible npm copies do not create separate
write queues. A second incompatible runtime major must fail closed with a clear
diagnostic. Session-specific state remains in the relevant extension or Pi
session log.

## 3. Dependency direction

```text
pix-core ───────────────► pix-runtime
   │                         ▲
   ├─► pix-data              │
   ├─► pix-pretty ───────────┤
   └─► feature packages ─────┘

pix-runtime ──peer──► Pi host
pix-runtime ──X─────► pix-core / pix-data / pix-pretty / feature packages
```

`pix-runtime` must have no dependency on another `@xynogen/pix-*` package. It
may peer-depend on the Pi host for `getAgentDir()` and extension types. Keeping
this direction acyclic prevents the runtime from turning into another bundle.

`pix-core` registers `pix-runtime` first, before all consumers. Direct installs
remain supported: importing a runtime accessor lazily creates the singleton and
loads the built-in sections even if the extension factory was not run.
The factory is still required for `/pix`, session lifecycle hooks, and user
notifications.

## 4. Storage contract

### 4.1 Canonical path

Always resolve the file through Pi's agent directory:

```ts
join(getAgentDir(), "pix.json")
```

This respects `PI_CODING_AGENT_DIR`; it must not reconstruct the path from
`HOME`. Tests inject an explicit `agentDir` adapter rather than mutating the
real user directory.

### 4.2 File shape

The file is a sparse document with a format version:

```jsonc
{
  "$version": 1,
  "pretty": {
    "icons": "ascii",
    "diff": { "splitMinWidth": 170 }
  },
  "optimizer": {
    "caveman": "lite",
    "rtk": "on"
  }
}
```

Top-level sections in v1:

```ts
interface PixConfigV1 {
  $version: 1;
  collapse: {
    enabled: boolean;                    // default true
    delaySec: number;                    // default 10
    tools: Partial<Record<string, boolean>>;
  };
  pretty: {
    icons: "nerd" | "unicode" | "ascii"; // default nerd
    lsStyle: "grid" | "tree";          // default grid
    maxPreviewLines: number;             // default 80
    maxRenderLines: number;              // default 150
    maxHighlightChars: number;           // default 80000
    cacheLimit: number;                  // default 128
    diff: {
      splitMinWidth: number;             // default 150
      splitMinCodeWidth: number;         // default 60
    };
  };
  optimizer: {
    caveman: "off" | "lite" | "full" | "ultra" | "micro"; // default off
    rtk: "off" | "on";                                      // default on
    ponytail: "off" | "lite" | "full" | "ultra";          // default off
  };
  gate: {
    disableDefaults: boolean;            // default false
    autoApprove: string[];               // default []
    extraRules: Array<{
      pattern: string;
      flags?: string;
      severity?: "risky" | "dangerous" | "critical";
      reason?: string;
    }>;
  };
}
```

The **resolved snapshot** always contains every field. The **persisted file**
contains `$version` plus sparse known values. Runtime tracks provenance for
known paths (`explicit` versus `inherited`): an explicitly written value is
retained even when it currently equals the default, while untouched inherited
defaults are omitted. This prevents a future default change from silently
changing an explicit user choice. `reset()` clears explicit provenance and
restores inheritance.

Unknown top-level sections and unknown keys inside known sections are preserved
on read/write so a newer or standalone package is not erased by an older
runtime. Runtime therefore keeps a private raw-document shadow beside the typed
snapshot; the presence of known paths in that shadow is their explicit-value
provenance. Section serialization merges known fields into that shadow rather
than reconstructing the whole file from typed values. Unknown data is not
exposed through typed selectors in v1.

`$version` is metadata and is always persisted after the first successful
migration/write. An entirely default v1 config is therefore:

```json
{ "$version": 1 }
```

### 4.3 Atomic writes

All writes use one serialized in-process queue and a short-lived cross-process
lock (`pix.json.lock`, acquired with exclusive creation). The lock contains PID
and timestamp metadata, uses bounded retry/backoff, and may be reclaimed only
when it is older than the configured stale threshold and its owning process is
confirmed absent where the platform supports that check. Lock timeout returns a
typed error rather than writing concurrently.

Inside the lock, every transaction:

1. reads the latest on-disk document (never trusts only the cached shadow);
2. migrates and validates it;
3. applies the typed update;
4. merges known fields while preserving unknown raw fields;
5. omits inherited defaults recursively while retaining explicitly set values;
6. writes `<pix.json>.tmp-<pid>-<nonce>` in the same directory;
7. flushes and closes the temporary file;
8. renames it over `pix.json` atomically and best-effort flushes the directory;
9. releases the cross-process lock in `finally`;
10. updates the in-memory snapshot;
11. emits one change event.

Use mode `0o600` for a newly created file and temporary file. No caller writes
`pix.json` directly. A failed lock/write/rename leaves the old file intact, does
not change the snapshot, and returns a typed error. The runtime never silently
reports success. This protects both multiple sessions in one process and
multiple Pi processes sharing the same agent directory.

## 5. Schema registry

Runtime models configuration as typed sections rather than exposing one
stringly typed mega-object. Built-in sections (`collapse`, `pretty`,
`optimizer`, `gate`) live in runtime so the core config works immediately.
V1 keeps the registry internal: there is no stable dynamic registration API
until a real optional-package use case proves its lifecycle and ownership
semantics. Unknown raw sections are still preserved, so this does not block
forward compatibility.

```ts
export interface ConfigSection<T> {
  key: string;
  defaults: Readonly<T>;
  parse(raw: unknown, ctx: ParseContext): T;
  serialize?(value: T, defaults: T): unknown;
  settings?: readonly SettingDescriptor<T>[];
}

export function defineSection<const K extends string, T>(
  definition: ConfigSection<T> & { key: K },
): SectionHandle<K, T>;

```

Registry rules:

- duplicate built-in keys fail at module initialization;
- parsers are pure and synchronous;
- invalid fields fall back individually and produce diagnostics rather than
  invalidating the whole file;
- `gate.extraRules` validates both regex pattern and flags during parsing, so
  malformed expressions become `INVALID_VALUE` diagnostics and never throw at
  tool-call time;
- a future public `registerSection()` API requires a separate design/release.

Built-in handles are exported from `@xynogen/pix-runtime/sections`:

```ts
collapseSection
prettySection
optimizerSection
gateSection
```

This avoids stringly typed access in consumers.

## 6. Public API

### 6.1 Runtime access

```ts
export interface PixRuntime {
  readonly path: string;
  readonly ready: boolean;

  init(options?: InitOptions): Promise<ConfigSnapshot>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;

  snapshot(): ConfigSnapshot;
  get<K extends string, T>(section: SectionHandle<K, T>): Readonly<T>;

  update<K extends string, T>(
    section: SectionHandle<K, T>,
    updater: DeepPartial<T> | ((current: Readonly<T>) => T),
    options?: UpdateOptions,
  ): Promise<ConfigChange | undefined>;

  reset<K extends string, T>(
    section: SectionHandle<K, T>,
    paths?: readonly ConfigPath<T>[],
    options?: UpdateOptions,
  ): Promise<ConfigChange | undefined>;

  reload(options?: ReloadOptions): Promise<ConfigChange | undefined>;
  subscribe(listener: ConfigListener, options?: SubscribeOptions): () => void;
  diagnostics(): readonly ConfigDiagnostic[];
}

export function pixRuntime(): PixRuntime;
```

Convenience functions may delegate to the singleton:

```ts
config(section)
updateConfig(section, patch, options?)
onConfigChange(listener, options?)
reloadConfig(options?)
```

There is deliberately no untyped `savePixConfig(Record<string, unknown>)` in
the stable API. Patch semantics are explicit: objects merge recursively, arrays
replace, `undefined` is rejected, and `null` is accepted only when the section
schema permits it. `reset()` is the only way to restore defaults/delete known
persisted paths. A functional updater receives the latest section parsed from
disk inside the transaction lock, not a stale cached value.

### 6.2 Snapshots and immutability

Every successful commit creates a deeply frozen snapshot with a monotonically
increasing in-process revision. Reads are synchronous after lazy initialization:

```ts
interface ConfigSnapshot {
  readonly revision: number;
  readonly formatVersion: 1;
  readonly loadedAt: number;
  get<K extends string, T>(section: SectionHandle<K, T>): Readonly<T>;
}
```

`runtime.get(section)` and `snapshot.get(section)` return deeply frozen section
values. The latter lets change listeners compare previous/current values
without reaching back into mutable runtime state. Consumers must not retain and
mutate them. Updates are immutable and typed.

### 6.3 Change events

```ts
type ConfigChangeOrigin =
  | "init"
  | "command"
  | "api"
  | "reload"
  | "migration";

interface ConfigChange {
  readonly revision: number;
  readonly origin: ConfigChangeOrigin;
  readonly source?: string; // e.g. "pix-pretty:/pix" or "pix-optimizer:/optimizer"
  readonly changed: readonly string[]; // JSON paths, e.g. "pretty.icons"
  readonly previous?: ConfigSnapshot; // absent only for init/immediate delivery
  readonly current: ConfigSnapshot;
  readonly persisted: boolean;
}
```

Mutation/reload events fire only after success and only when the resolved
config actually changes. A no-op `update()`/`reset()` returns `undefined`.
Initialization emits one `origin: "init"` event with no `previous` snapshot;
`{ immediate: true }` delivers that same shape for the current snapshot to the
new listener only. Listener failures are isolated and reported as diagnostics;
they do not roll back a committed write. Dispatch occurs in registration order
from a copied listener list so unsubscribe during dispatch is safe.

Filtering is built in:

```ts
runtime.subscribe(listener, { paths: ["pretty.icons", "optimizer.*"], immediate: true });
```

This is an in-process event bus only. External edits become visible when
`reload()` is explicitly called or when a future Pi config-reload lifecycle
hook invokes it. V1 intentionally avoids a permanent filesystem watcher.
Listener-triggered updates are appended to the write queue after current event
dispatch, preventing recursive commits and preserving event order.

## 7. Initialization and lifecycle

The extension entry point is idempotent:

```ts
export default function registerRuntime(pi: ExtensionAPI): void;
```

A process-global compatible-runtime record contains a registration token that
prevents duplicate command/lifecycle registration when runtime is installed
directly and also imported through `pix-core` (even if package copies receive
different wrapper objects for the Pi host). On first registration it:

1. installs built-in section definitions;
2. creates the process singleton using `getAgentDir()`;
3. registers `/pix`;
4. registers one `session_start` hook that calls `init()` the first time and
   `reload()` on later sessions, then surfaces aggregated migration/parse
   diagnostics through the UI;
5. registers one `session_shutdown` hook that calls `flush()`.

A session shutdown does not destroy process-wide subscriptions: Pi may start
another session in the same process. Explicit `shutdown()` is reserved for
process teardown and tests; it flushes writes, releases runtime resources, and
clears listeners.

`init()` itself is single-flight. Concurrent calls share one promise. It:

1. creates the agent directory if needed;
2. acquires the in-process write queue;
3. reads `pix.json` without modifying it yet;
4. detects the source format;
5. runs ordered migrations;
6. parses all built-in sections;
7. imports legacy sidecars;
8. atomically persists the canonical sparse document if migration changed it
   and the current release stage allows that migration;
9. freezes and publishes the first snapshot;
10. emits one consolidated event: `init` when no lazy snapshot existed, or
    `migration` when a prior lazy snapshot changed. If a lazy snapshot is still
    identical, initialization emits nothing; `{ immediate: true }`
    subscriptions already received that snapshot.

Consumers may call `get()` before `session_start`; this performs a synchronous,
read-only lazy load so module-level constants continue to work during the
transition. It does not migrate or write, but it may read a valid legacy optimizer sidecar
as a temporary overlay so optimizer controls do not flicker to defaults before
initialization. Later `init()` reparses under the normal transaction lock and
publishes any difference. Packages should migrate
module-level config constants to functions or subscriptions because a constant
cannot react to `/pix` changes.

Runtime resolves only JSON values plus schema defaults. Legacy package-specific
environment variables are not folded into the persisted snapshot because doing
so would make sparse serialization and change events ambiguous. During the
compatibility window, each consumer may apply its existing environment override
on top of `runtime.get(section)` using its current precedence; those variables
should be documented as external overrides and deprecated separately.

## 8. Migration design

Migrations are ordered, idempotent, and pure over a `RawDocument`:

```ts
interface Migration {
  from: number | "unversioned";
  to: number;
  migrate(document: RawDocument, context: MigrationContext): MigrationResult;
}
```

### 8.1 Unversioned `pix.json` → v1

- retain valid `collapse`, `pretty`, `optimizer`, and `gate` values;
- remove `pretty.theme`, `pretty.syntaxTheme`, `pretty.diffColors`, and legacy
  diff color fields because active Pi themes own all colors;
- preserve unknown keys;
- normalize default-valued entries out of the persisted document;
- set `$version: 1`.

### 8.2 `optimizer.json` → `pix.json.optimizer`

Import `join(getAgentDir(), "optimizer.json")` exactly once:

- validate each optimizer value independently;
- when both files contain a valid value, existing `pix.json.optimizer.<key>`
  wins;
- otherwise import the valid sidecar value;
- write canonical `pix.json` first;
- only after that rename the sidecar to `optimizer.json.migrated-v1`;
- if the archive name exists, append a timestamp;
- never delete the sidecar before the canonical write succeeds;
- malformed sidecars remain untouched and generate a visible diagnostic;
- future starts skip archived files, making migration idempotent.

Migration is deliberately staged because already-published `pix-data` versions
delete `raw.optimizer` whenever they save:

1. the Phase-A `pix-data` compatibility release removes that deletion and makes
   every config write delegate to runtime;
2. every first-party package still depending on `pix-data` raises its
   `pix-data` floor to that compatibility version in the same release train,
   preventing npm from resolving a known pre-delegate version for those
   packages; package manifests and `bun.lock` are audited before tagging;
3. the first optimizer-runtime release imports into `pix.json` but keeps
   `optimizer.json` as a compatibility mirror/read fallback for one full
   release train; optimizer updates write canonical config first, then update
   the mirror;
4. if an old writer erases `pix.json.optimizer`, runtime restores it from the
   mirror on the next locked initialization/reload. The reverse compatibility
   direction is not fully enforceable for arbitrary third-party/stale installs,
   so the mirror remains the authoritative rollback source during this window;
5. only after the compatibility window and published dependency-floor audit
   does runtime rename the mirror to `optimizer.json.migrated-v1` (timestamping
   conflicts). A competing process that already moved it makes `ENOENT` benign.

The archived sidecar then provides a transparent rollback/audit path. A later
major release may remove archived files, but v1 does not. This temporary mirror
is the sole exception to the eventual one-file storage rule and exists only to
avoid user-state loss during mixed-version upgrades.

### 8.3 Old runtimes and forward compatibility

If `$version` is greater than the maximum supported version, runtime enters
read-only compatibility mode:

- known sections may be read best-effort;
- no automatic normalization or migration occurs;
- all updates fail with `UNSUPPORTED_CONFIG_VERSION`;
- `/pix` displays the problem and the path instead of overwriting the file.

This is safer than letting an older package erase newer settings.

## 9. `/pix` and package-owned controls

`/pix` is registered by runtime because it edits the shared document. Its rows
come from section `settings` descriptors. This keeps persistence centralized
without making runtime know feature behavior.

A descriptor contains a path, label, parser/formatter, allowed values, and
optional visibility. These descriptors are internal to built-in runtime
sections in v1. Runtime supplies the generic overlay and calls
`runtime.update()`.

Ownership rule:

- `/pix` shows distro-wide settings such as icons, layout, collapse, and gate;
- `/optimizer` remains the optimizer's complete control surface;
- optimizer consumes runtime's built-in `optimizerSection` but does **not**
  register controls in `/pix`;
- `/optimizer` writes `optimizerSection` through runtime and subscribes to
  `optimizer.*` changes;
- config ownership and UI ownership are separate concepts.

The `/pix` headless summary marks non-default values and reports the canonical
path. It never dumps unknown sections or secrets.

## 10. Consumer migration

### Phase A — introduce runtime without behavior changes

1. Create `pix-runtime` with built-in sections, tests, and extension entry.
2. Add it as the first dependency/member in `pix-core`.
3. Keep temporary compatibility exports in `pix-data/pix-config` and
   `pix-data/collapse`, implemented as deprecated delegates to runtime. This
   release explicitly removes `delete raw.optimizer` and direct filesystem
   writes.
4. Make runtime read legacy unversioned `pix.json` but postpone sidecar import
   until optimizer has runtime support in the same release train.
5. Ship this compatibility release before enabling optimizer migration. This is
   essential because historical `pix-data.savePixConfig()` deletes the
   `optimizer` key and could otherwise destroy newly migrated state in a mixed
   install.
6. Update `AGENTS.md` now—not in final cleanup—to recognize runtime as a
   sanctioned shared layer and document the new dependency direction.
7. Keep `0.1.x` private/experimental while stabilizing the contract, publish
   `1.0.0` before broad Phase-B adoption, and then avoid 0.x caret-range churn
   across roughly twenty consumers.

### Phase B — move consumers

- `pix-pretty`: use `prettySection`; subscribe to `pretty.icons`; convert
  module-level numeric constants to getters or captured values refreshed on
  config events.
- runtime owns only pure `shouldCollapse()` and `collapseDelayMs()` policy;
  move the UI timer/state machine (`tickCollapse`, `CollapseState`) to
  `@xynogen/pix-pretty/collapse`, which consumes runtime policy. Tool packages
  already use pix-pretty for rendering and should not get UI state from runtime.
- `pix-gate`: read `gateSection` at tool-call time or rebuild compiled rules on
  `gate.*` changes so `/pix` updates are live.
- `pix-data`: remove config and command ownership; retain only data/cache APIs.
- tests: construct isolated runtimes with injected filesystem/path/log adapters,
  avoiding singleton and real-home leakage.

### Phase C — unify optimizer state

1. Add `pix-runtime` dependency to `pix-optimizer`.
2. Replace `loadOptValue`/`saveOptValue` with `runtime.get/update` on
   `optimizerSection`.
3. Preserve session-log entries for branch-local restoration only: initialize
   from global config, then let a valid current-branch session entry override
   the live value without rewriting global config. An explicit `/optimizer`
   change writes both the branch entry and global preference.
4. Enable canonical sidecar import plus the temporary compatibility mirror;
   archive `optimizer.json` only after the audited compatibility window.
5. Keep `/optimizer` as the only optimizer UI.

### Phase D — remove compatibility layer

After all first-party consumers have shipped runtime-based versions:

- remove `pix-config.ts`, `/pix`, and config docs from `pix-data`;
- move collapse implementation and tests to runtime;
- remove deprecated exports in the next planned breaking release of `pix-data`;
- remove compatibility wording from `AGENTS.md`; runtime was already added as a
  sanctioned layer in Phase A.

## 11. Testing requirements

The runtime release is blocked unless tests cover:

### Schema and normalization

- every built-in default resolves correctly;
- invalid fields fall back individually and produce path diagnostics;
- inherited defaults are removed recursively while explicit default-valued
  choices survive;
- unknown fields survive updates;
- snapshots are deeply immutable;
- duplicate built-in section registration is rejected;
- malformed gate regex patterns/flags become diagnostics.

### Persistence

- writes are atomic and leave no temp file after success;
- simulated write/rename failures preserve the old file and snapshot;
- concurrent updates in one process and in two simulated processes are
  serialized without lost fields;
- functional updaters receive the latest locked on-disk value;
- no-op updates neither write nor emit;
- custom `PI_CODING_AGENT_DIR` is respected;
- new files use restrictive permissions where supported.

### Migration

- unversioned config migrates to v1;
- legacy color keys are removed;
- optimizer sidecar imports valid values and serves as a temporary read/write
  compatibility mirror;
- canonical optimizer values win conflicts;
- malformed sidecars remain untouched;
- sidecar archives only after successful canonical write and the audited
  compatibility window;
- rerunning migration is idempotent, and concurrent archive `ENOENT` is benign;
- future versions enter read-only mode.

### Events and lifecycle

- initialization is single-flight and idempotent;
- events contain correct optional-previous/current snapshots and changed paths;
- path filters and immediate subscriptions work;
- listener errors are isolated;
- session flush and explicit shutdown drain pending writes without breaking
  subscriptions needed by a later session;
- direct package use works without `pix-core` registration.

### Integration

- `/pix` updates icon mode live;
- `/optimizer` updates only optimizer config and remains its sole UI;
- gate rules rebuild after a gate config change;
- collapse policy changes affect newly rendered cards;
- installing `pix-data` alone no longer registers `/pix` after compatibility
  removal.

## 12. Error and diagnostic model

No config failure should crash Pi, but failures must be visible and
inspectable. Runtime keeps bounded diagnostics and exposes them to `/pix`:

```ts
interface ConfigDiagnostic {
  code:
    | "PARSE_ERROR"
    | "INVALID_VALUE"
    | "READ_FAILED"
    | "WRITE_FAILED"
    | "MIGRATION_FAILED"
    | "UNSUPPORTED_CONFIG_VERSION"
    | "LISTENER_FAILED";
  severity: "warning" | "error";
  path?: string;
  message: string;
  cause?: unknown;
  at: number;
}
```

At session start, aggregate diagnostics into at most one notification to avoid
noise. `/pix` provides the detailed paths. Never include config values in error
messages unless they are known non-sensitive enum/number values.

## 13. Recommended source layout

```text
packages/pix-runtime/
  package.json
  README.md
  DESIGN.md
  src/
    index.ts             # extension entry + stable public exports
    runtime.ts           # singleton and PixRuntime implementation
    registry.ts          # internal built-in section registry
    schema.ts            # shared types and validation helpers
    sections/
      index.ts
      collapse.ts
      pretty.ts
      optimizer.ts
      gate.ts
    persistence.ts       # read, sparse serialize, atomic write, queue
    migrations.ts        # versioned migrations and sidecar importer
    events.ts            # listener registry and path filtering
    collapse.ts          # pure collapse policy only
    diagnostics.ts
    pix-command.ts
    testing.ts           # createIsolatedRuntime(adapters)
```

Suggested exports:

```jsonc
{
  ".": "./src/index.ts",
  "./config": "./src/runtime.ts",
  "./sections": "./src/sections/index.ts",
  "./collapse": "./src/collapse.ts",
  "./testing": "./src/testing.ts"
}
```

## 14. Acceptance criteria

`pix-runtime` is ready to release when:

1. all config paths use `getAgentDir()` and honor `PI_CODING_AGENT_DIR`;
2. `pix.json` is versioned, sparse, validated, atomically written, and guarded
   against concurrent writers;
3. unknown fields survive older-runtime updates and future versions fail closed;
4. optimizer state migrates once with an archived rollback file;
5. failed writes cannot corrupt or falsely update the live snapshot;
6. typed, filtered change events update icons, gate rules, and optimizer state;
7. `/pix` and `/optimizer` retain separate ownership;
8. `pix-data` can become a pure model-data package;
9. `pix-core` remains an ordered aggregator with runtime first;
10. standalone packages work without pix-core through lazy runtime access;
11. the full test, typecheck, lint, dependency, migration, and publish dry-run
    suites pass.
