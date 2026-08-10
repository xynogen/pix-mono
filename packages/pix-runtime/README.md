# pix-runtime

Pix's small shared runtime layer. It owns the process-wide config contract:
`~/.pi/agent/pix.json` as a single, sparse, versioned user config file, plus the
lifecycle that keeps it coherent.

It is **not** an aggregator, renderer, model-data package, or service locator.
See `DESIGN.md` for the full contract.

## What it does

- Versioned, sparse `pix.json` (`$version: 1`) — defaults resolve in code.
- Typed sections: `collapse`, `pretty`, `io`, `compaction`, `optimizer`, `gate`.
- Atomic writes behind a serialized in-process queue and a short-lived
  cross-process lock. A failed write leaves the old file intact.
- Immutable, deeply frozen config snapshots with a monotonic revision.
- Typed, path-filtered change events.
- One-time migration of legacy unversioned config and the `optimizer.json`
  sidecar.
- The `/pix` shared-settings command.

## Install

```bash
pi install npm:@xynogen/pix-runtime
```

Standalone-installable: importing an accessor lazily creates the singleton even
without the extension factory. Installed via `pix-core` it registers `/pix` and
session hooks once.

## Usage

```ts
import { config, updateConfig, onConfigChange } from "@xynogen/pix-runtime/config";
import { prettySection } from "@xynogen/pix-runtime/sections";

const icons = config(prettySection).icons;         // synchronous read
await updateConfig(prettySection, { icons: "ascii" });
const off = onConfigChange((c) => render(), { paths: ["pretty.icons"] });

import { ioTimeoutMs, ioTimeoutSignal } from "@xynogen/pix-runtime/io";
const timeoutMs = ioTimeoutMs();                    // shared network timeout
const signal = ioTimeoutSignal(toolSignal);         // timeout + cancellation
```

Set `io.timeoutSec` in `~/.pi/agent/pix.json`, or change **Network → timeout (sec)**
with `/pix`. The default is 30 seconds. It applies to Pix network operations,
including remote skills, web fetch/search/transcription, MCP requests and
connection bootstrap, background model-data refreshes, and update downloads.

Set `compaction.triggerPercent` in `~/.pi/agent/pix.json`, or change **Compaction →
Trigger (% ctx)** with `/pix`. It is the context-window usage percent (0–100) used
to calculate the trigger; the default is `60` and `0` disables the self-trigger
(pi decides when to compact). The `/pix` picker offers 0, 5, 10, 15, 20, 25, 30,
40, 50, 60, 70, 80, 90.

`compaction.minimumTokens` is the absolute floor for that calculation. The
effective threshold is `max(contextWindow × triggerPercent, minimumTokens)`, so
a 300K-context model at 10% waits for 100K tokens instead of compacting at 30K.
The default floor is 100K and the hard minimum is 25K (values below clamp up);
`/pix` offers 25K, 50K, 100K, 150K, 200K, 300K, 400K, 600K, 800K, and 1M.
pix-core consumes both settings.

Collapse policy helpers:

```ts
import { shouldCollapse, collapseDelayMs } from "@xynogen/pix-runtime/collapse";
```

## Agent state and herdr notifications

### Agent-state coordinator

`src/herdr-state.ts` (exported from the package index) is a process-wide
coordinator that tracks whether the agent is `working`, `blocked`, or `idle`,
keyed per Pi `EventBus`. On every transition it emits a `pix:agent-state` event:

```ts
{ state: "working" | "blocked" | "idle", message?: string, activities: number, blocks: number }
```

Two lease primitives drive it. Both return an idempotent release function:

- `beginAgentActivity(events, source, message?)` marks asynchronous work in
  progress (for example a running subagent). State reports `working` while any
  activity lease is open.
- `withAgentBlock(events, source, message, prompt)` holds `blocked` state for the
  duration of an awaited `prompt()` and always releases it, even on throw. Blocks
  take priority over activities, so state is `blocked` whenever any block lease is
  open.

`bindAgentStateEvents(events)` replays the current state and answers
`pix:agent-state:request`. `resetAgentState(events)` clears all leases on session
shutdown.

Nested leases collapse to a single state: two open blocks still report `blocked`
until both release.

Consumers that open a block today: `pix-ask` (`ask_user`, "Waiting for user
answer"), `pix-gate` (approval prompts), and `pix-sudo` (root approval).
`pix-subagent` opens activity leases for running background agents.

```ts
import { withAgentBlock, beginAgentActivity } from "@xynogen/pix-runtime";

// Hold blocked state while waiting on the user:
await withAgentBlock(pi.events, "ask_user", "Waiting for user answer", () => promptUser());

// Mark background work:
const done = beginAgentActivity(pi.events, "subagent", "Agent running");
// ... later ...
done();
```

### herdr notification bridge

`src/herdr-notify.ts` (exported as `bindHerdrNotify`) is a leaf subscriber on
`pix:agent-state`. When the agent transitions INTO `blocked` it spawns:

```bash
herdr notification show <message> --sound request
```

so a user away from their terminal gets a popup and sound. `request` is herdr's
built-in "needs attention" cue. The trigger is edge-triggered: it fires once per
entry into `blocked`, not repeatedly, and nested blocks stay a single
notification.

The bridge is fire-and-forget. The child is `detached`, `unref`'d, and
`stdio: "ignore"`, and a missing `herdr` binary is swallowed, so it never blocks
the prompt path or throws. herdr owns the toast's color, position, and sound via
its own server config (`[toast]` / `[notification]`); pix only reports the moment
and the message. Compaction and other autonomous work never enter `blocked`, so
they never notify.

It is wired automatically by the runtime extension: bound at session start,
unbound at shutdown. No manual setup beyond running inside a herdr pane.

Two environment variables control it:

- `HERDR_ENV` — herdr sets this to `1` inside its own pane. The bridge only runs
  when `HERDR_ENV === "1"`; outside a herdr pane it is a no-op and spawns
  nothing.
- `PIX_HERDR_NOTIFY` — set to `0` to silence notifications even inside a herdr
  pane.

## Testing

```ts
import { createIsolatedRuntime } from "@xynogen/pix-runtime/testing";

const { runtime, cleanup } = createIsolatedRuntime();
// ... exercise runtime against a temp agent dir ...
cleanup();
```
