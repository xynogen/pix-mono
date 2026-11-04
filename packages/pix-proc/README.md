<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-proc

Pi tool to run and manage long-lived processes that must outlive a single agent
turn — `npm run dev`, `vite`, `python main.py`, or a test watcher. The `proc`
tool starts a detached process, the child writes its own output to a log file,
and the agent manages it by a short `proc-*` handle.

## Why not `bash`

`bash` is synchronous: it blocks until the command exits, then returns. It cannot
supervise a process that keeps running. `proc` starts a process, returns a handle,
and lets the agent keep working, then read output, or stop it later. For one-shot
commands use `bash` — `proc start` reports and steers you back when a command
exits fast.

## Tool

The `proc` tool supports five actions:

| Action | Required input | Result |
|---|---|---|
| `start` | `command` | Spawns a detached process, returns a `proc-*` handle plus its first output (short wait window) |
| `list` | None | Lists processes with handle, command, uptime, status, and last output line |
| `logs` | `handle` | Returns new output since your last read; pass `tail` for the last n lines |
| `stop` | `handle` | Sends SIGTERM to the whole process group, then SIGKILL after a 2s grace |
| `rm` | `handle` | Removes a stopped process and its log file (refuses while running) |

`start` also accepts `cwd` (working directory, default the session cwd) and `name`
(a friendly label). `logs` accepts `tail` (integer, max 1000).

Example calls:

```ts
proc({ action: "start", command: "npm run dev" });
proc({ action: "list" });
proc({ action: "logs", handle: "proc-swift-otter-42" });      // new lines since last read
proc({ action: "logs", handle: "proc-swift-otter-42", tail: 50 }); // last 50 lines
proc({ action: "stop", handle: "proc-swift-otter-42" });
proc({ action: "rm", handle: "proc-swift-otter-42" });
```

## Log model

- The whole stdout+stderr is kept on disk at `~/.cache/pi/proc/<handle>.log`.
  The complete output stays available for a human to read directly.
- `logs` never dumps the whole file. By default it returns only the lines added
  since your last `logs` call for that handle (a per-handle cursor), capped at
  1000. `tail n` forces the last n lines and does not move the cursor.
- The cursor holds at the last newline, so a half-written line is never returned.

## Cap

Each log is capped at 50 MB. At the cap the tool **stops recording** — it does
not rewrite or drop older lines, so the file stays intact and complete up to the
cap. The process keeps running. `logs`, `list`, and the widget report `capped`.

## Process lifecycle

- Processes are spawned detached, each leading its own process group. `stop`
  kills the whole group (`kill -pgid`), so `vite`/`esbuild` children do not
  survive as orphans holding a port.
- Every running process writes a pidfile with its process-group id and start
  time. On the next session start, pix-proc finds orphaned groups left by a
  crashed session and lists them in a confirm overlay. **Keep all** (the first
  choice) adopts and tracks them; **Kill all** terminates them. Nothing is
  killed silently.
- On a clean session shutdown, pix-proc stops every process it owns.

## User command

`/proc` lets you inspect and control processes without the model:

- `/proc` — open the process modal. The list shows each handle, command, uptime, and status.
  - `enter` opens a process: its details, the last 200 log lines (`PgUp`/`PgDn` to scroll), and a Stop or Remove action.
  - `s` stops the selected running process. `r` removes the selected finished process and its log.
  - `esc` goes back, then closes. Each stop or remove shows a notification with the result.
  - The modal refreshes every second: status, uptime, and the open log tail stay current.

Without a TUI (headless or RPC), `/proc` prints the process list as a notification.

## Limits

Processes are attached to the Pi session and stop when the session ends. A
survive-restart daemon, a `restart` action, a `pix.json` config section, and
stdin/TTY passthrough for watchers that need a PTY are outside current scope.

## Development

```bash
bun test packages/pix-proc
bun run check
bun run typecheck
```

`bun run typecheck` checks the full monorepo, not only this package.

## Install

```bash
pi install npm:@xynogen/pix-proc
```

> Standalone and opt-in. [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core) does not bundle it. It starts background processes.

Install `@xynogen/pix-gate` for command gating on `proc`, the same gate that
guards `bash`. Without pix-gate, `proc start` is exactly as ungated as `bash` is
without pix-gate — the same trust surface.

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

MIT. See [LICENSE](LICENSE).
