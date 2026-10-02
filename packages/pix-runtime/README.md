# pix-runtime

Pix's small shared runtime layer. It owns the process-wide config contract:
`~/.pi/agent/pix.json` as a single, sparse, versioned user config file, plus the
lifecycle that keeps it coherent.

It is **not** an aggregator, renderer, model-data package, or service locator.
See `DESIGN.md` for the full contract.

## What it does

- Versioned, sparse `pix.json` (`$version: 1`) — defaults resolve in code.
- Typed sections: `collapse`, `pretty`, `io`, `compaction`, `optimizer`, `gate`, `fetch`, `search`, `voice`, `toolbox`.
- `/pix` has a Footer tab for `pretty.footer` visibility.
- Startup imports legacy service config files and archives them only after a successful save.
- Atomic writes behind a serialized in-process queue and a short-lived
  cross-process lock. A failed write leaves the old file intact.
- Immutable, deeply frozen config snapshots with a monotonic revision.
- Typed, path-filtered change events.
- One-time migration of legacy unversioned config and the `optimizer.json`
  sidecar.
- The `/pix` shared-settings command, with **Settings** and **Binaries** tabs.
- One catalog, resolver and downloader for every external command pix runs
  (`binaries`), plus shared `paths` and `platform` helpers.
- **User shell** — user `!` commands run through PowerShell on Windows (pwsh 7,
  else 5.1), and through `$SHELL` on Linux/macOS (zsh sources `.zshrc` so
  aliases expand).

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

Set `pretty.maxRenderWidth` and `pretty.maxRenderHeight` in `~/.pi/agent/pix.json`,
or change **Pretty → max modal width/height** with `/pix`. Values accept terminal
percentages such as `"65%"`/`"80%"` or fixed columns/rows such as `96`/`20`.
Percentage choices in `/pix` move in 5% steps. Width is the rendered frame width;
height is the threshold where modal content starts paging.

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

## Paths and platform

```ts
import { agentDir, binDir, cacheDir, homeDir, projectDir, tempDir } from "@xynogen/pix-runtime/paths";
import { currentPlatform, hostPlatform } from "@xynogen/pix-runtime/platform";

agentDir();   // PI_CODING_AGENT_DIR (~-expanded) or ~/.pi/agent, same as Pi's getAgentDir
binDir();     // <agentDir>/bin, the folder where Pi downloads fd/rg and pix downloads its tools
cacheDir();   // $XDG_CACHE_HOME/pi or ~/.cache/pi (never relies on HOME alone)
projectDir(cwd); // <cwd>/.pi, Pi's project config dir. projectDir() gives the relative .pi
tempDir();    // os.tmpdir(): TMPDIR on POSIX, TEMP/TMP on Windows. Shared, so delete only your own entries
currentPlatform(); // { os, arch, libc?, wsl, termux, exe }
```

Every helper takes an optional env, so tests can use a temporary agent dir.

## Binaries

Every external command a pix package runs is listed in one catalog
(`src/binaries/catalog.ts`). The catalog records which packages use each
command, which OS needs it, an install hint, and, for a few commands, a trusted
GitHub release.

```ts
import { ensureTool, requireTool, resolveTool } from "@xynogen/pix-runtime/binaries";

resolveTool("git");                   // sync, no network: { path, source } | undefined
requireTool("ssh");                   // same, but throws BinaryMissingError with the install hint
await ensureTool("hunk", { onStatus }); // downloads into <agentDir>/bin when missing
```

**Resolve order:** `binary.json` path → `<agentDir>/bin` → known install dirs (`system`, e.g. Git Bash on Windows) → PATH. `ensureTool`
then downloads if the catalog has a release for this host.

If `binary.json` names a file that doesn't exist, the entry is **broken**. pix
never silently falls back to another copy.

| Downloaded when missing | Source | Checksum |
|---|---|---|
| `rtk` (Windows, Linux, macOS) | `rtk-ai/rtk` latest release | `checksums.txt` |
| `hunk` (Windows, Linux, macOS) | `modem-dev/hunk` latest release | `SHA256SUMS` |
| `aria2c` (Windows only) | official `aria2/aria2` release | none published |
| `ffmpeg` (Windows, Linux, ~120 MB) | `BtbN/FFmpeg-Builds` lgpl | `checksums.sha256` |

Everything else, including `rg`, is only checked and never downloaded.
Pi itself downloads `rg` and `fd`. pix does not run `fd`, so the catalog does not list it.

The downloader:

- finds the latest version through the `/releases/latest` redirect;
- extracts with the system `tar`/`unzip`;
- works in a unique temp folder and cleans it up afterwards;
- shares one download between concurrent calls for the same binary;
- respects `PI_OFFLINE`.

Progress is reported only through `onStatus`. Use
`reportToolStatus(ctx.ui)` from `@xynogen/pix-pretty/tool-status` so every
package shows downloads the same way.

### Running a binary — `./exec`

Packages never start a catalogued binary by bare name. `./exec` resolves it
through the order above, then runs it:

```ts
import { runTool, runToolSync, spawnTool } from "@xynogen/pix-runtime/exec";

const r = await runTool("git", ["status", "--porcelain"], { cwd, timeoutMs: 2_000 });
// { code, stdout, stderr, stdoutBytes, timedOut, tool: { path, source } }

const child = spawnTool("ssh", args, { stdio: ["ignore", "pipe", "pipe"] }); // Node ChildProcess
const sync = runToolSync("npm", ["root", "-g"], { timeoutMs: 10_000 });
```

- `runTool` downloads first when the binary is missing and has a recipe
  (progress via `onStatus`). `spawnTool` and `runToolSync` never download.
- A missing binary throws `BinaryMissingError` with the install hint. A
  non-zero exit resolves normally, so check `code`.
- Windows `.cmd`/`.bat` shims (`npm`, `npx`, `pi`) run through
  `cmd.exe /d /s /c` with strict quoting, since Node cannot spawn them
  directly. Spaces, quotes, `&|<>^%` and parentheses survive intact.
- Timeouts and aborts kill the whole process tree on Windows
  (`taskkill /T`), so a wrapped shim does not keep running.

### OS jobs — `./os`

Jobs that need a different program on each OS sit behind one call. Each
program still resolves through `binary.json`:

```ts
import { openTarget, readClipboardImage, runGit } from "@xynogen/pix-runtime/os";

await openTarget(url, { app: process.env.BROWSER }); // open / cmd start / xdg-open / wslview
const img = readClipboardImage();                    // PowerShell (Windows, WSL) / wl-paste / xclip
const branch = await runGit(["branch", "--show-current"], { cwd }); // stdout | null
```

`runGit` returns `null` for any git failure (not a repo, timeout, abort) but
rejects with `BinaryMissingError` when git itself is missing. Background
features pass that to `warnBinaryMissing(ctx.ui, err)` from
`@xynogen/pix-pretty/tool-status`, which shows one warning per binary per
session, pointing at the `/pix` Binaries tab.

`scripts/binaries.test.ts` fails CI when a package starts a catalogued binary
by bare name.

### Audio — `./audio`

One job per function. Callers never see a program name or an OS branch.
ffmpeg does every job it can on Linux (PulseAudio/PipeWire), macOS
(AVFoundation/AudioToolbox) and Windows (DirectShow). ffmpeg has no audio
output on Windows, so playback there uses the built-in PowerShell MediaPlayer.

```ts
import { listMicrophones, playAudio, startRecording } from "@xynogen/pix-runtime/audio";

const mics = await listMicrophones();    // first entry is "default". No ffmpeg: only "default"
const rec = startRecording("default", { onLevel, onExit, onStatus }); // mono 16 kHz wav
await rec.stop();                         // rec.path is the wav. { meterOnly: true } writes nothing
await playAudio(file, { signal });        // resolves when the sound ends
```

### Safe output paths — `./safe-path`

`validateOutputPath(absPath)` checks a model-chosen write target before the
write. It rejects null bytes, system dirs (`/etc`, `/proc` … or
`C:\Windows`, `Program Files`), secret dirs under home (`.ssh`, `.aws`,
`.gnupg`, GitHub CLI), symlinks and Windows junctions, existing directories,
and paths with no writable ancestor. Matching is per path segment, and
case-insensitive on Windows.

### `~/.pi/agent/binary.json`

This file is user configuration. It holds only the binaries you override. The
file does not exist until you set a path. The `/pix` Binaries tab shows the
full catalog of what pix depends on.

```json
{
  "$version": 1,
  "ffmpeg": "D:/tools/ffmpeg/bin/ffmpeg.exe"
}
```

- A missing entry (or `null`) means automatic: pix looks in `bin`, then known install dirs, then PATH, then downloads.
- A path means pix always uses exactly that file.

pix writes to the file only in two cases:

- when you edit or reset a path in the `/pix` Binaries tab (reset removes the entry);
- to remove legacy `null` entries for catalog binaries from an older file.

Paths pix finds on its own are never written to it. Keys pix doesn't know are
kept. If the file contains invalid JSON, pix reports it and leaves the file
unchanged.

### `/pix` → Binaries tab

Press **Tab** / **Shift+Tab** to switch between Settings and Binaries. Each row
shows a status icon with a text label (ok / missing / broken / not used on this
OS), the resolved path, where it was found, and its version. Selecting a row
also shows which packages use it.

| Key | Action |
|---|---|
| **enter** | install (downloadable, missing) or re-check |
| **e** | set a path (saved to `binary.json`) |
| **d** | reset the entry to automatic (removes it from `binary.json`) |
| **r** | re-check all entries |

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

## Install

```bash
pi install npm:@xynogen/pix-runtime
```

> Foundation library. Feature packages install it as a dependency. Install it directly only when you build your own extension on it.

Standalone-installable: importing an accessor lazily creates the singleton even
without the extension factory. Installed via `pix-core` it registers `/pix` and
session hooks once.

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

MIT
