# pix-nudge

Pi extension — model-steering nudges (tools + capability).

## What it does

Registers three nudge hooks. All are surgical — they name only the relevant tool, not a full inventory, and none blocks a call.

**Tools nudge** — catches `bash` calls that reimplement a first-class tool (`read`, `ls`, `grep`, `find`, `edit`), including `sed -n '10,40p'` reads, stand-ins with only a trailing `| head`/`| tail`, and commands that pix-optimizer has prefixed with `rtk`:

- Appends one `[pix-nudge]` line to that bash result **once per command category per session** (the model reads tool results, not UI notices), plus a yellow notice for the user. The line names the tool options that replace the shell idiom (for example `read` offset/limit). Deferred tools are pointed at `tool_search`.
- The command still runs — it teaches, doesn't block (early blocking wasted a turn on forced retry). Later calls in that category are silent.
- Bash stays available for everything else (pipes, compound commands, real shell work).

> **Nudge steers; it does not guard.** Privileged auth stand-ins (bash `sudo`/`ssh`) are *not* nudged here — those are hard-blocked and redirected to `sudo_run`/`ssh_run` by [`pix-gate`](../pix-gate), which handles the auth safely. Guarding (stop) and steering (teach) are separate concerns in separate packages.

**Capability nudge** — steers the model toward tool discovery over guessing:

- One-time orientation message on the **first prompt**: tool counts, the deferred-tool note, and a capability → tool map that lists only the tools registered in this session (`ask_user`, `read_skills()`, context7, `search`/`fetch`, `lsp_*`, `mcp`).
- A one-line reminder every 10 turns pointing at `read_skills()` and `tool_search`.
- When `.pi/graph/graph.json` exists and the `graph` tool is registered, both messages also route codebase questions to `graph(action:"query")`.
- Delivered as visible custom messages, not system-prompt rewrites, so the cached prompt prefix stays intact.

**Loop nudge** — catches a doom loop: the same tool, arguments and result **3 times in a row**, or the same cycle of up to 5 calls (A→B→A→B…) repeated 3 times. A failing call counts by tool and first error line, so the same error with tweaked arguments also counts. Appends one `[pix-nudge]` line to the third result plus a yellow notice. A changed result resets the streak, so re-running tests after an edit is not a loop.

## Install

```bash
pi install npm:@xynogen/pix-nudge
```

> Bundled in [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core). Install it alone only if you do not use pix-core.

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
