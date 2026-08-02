# pix-runtime

Pix's small shared runtime layer. It owns the process-wide config contract:
`~/.pi/agent/pix.json` as a single, sparse, versioned user config file, plus the
lifecycle that keeps it coherent.

It is **not** an aggregator, renderer, model-data package, or service locator.
See `DESIGN.md` for the full contract.

## What it does

- Versioned, sparse `pix.json` (`$version: 1`) — defaults resolve in code.
- Typed sections: `collapse`, `pretty`, `io`, `optimizer`, `gate`.
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

Collapse policy helpers:

```ts
import { shouldCollapse, collapseDelayMs } from "@xynogen/pix-runtime/collapse";
```

## Testing

```ts
import { createIsolatedRuntime } from "@xynogen/pix-runtime/testing";

const { runtime, cleanup } = createIsolatedRuntime();
// ... exercise runtime against a temp agent dir ...
cleanup();
```
