<!-- markdownlint-disable MD013 MD040 -->

# @xynogen/pix-env

Broker `.env` secrets to tools without ever putting the values in the model's context.

The AI sees only the **key names**. It writes `$KEY` / `${KEY}` in any tool
argument. On each `tool_call`, pix-env pops a yolo-style approval dialog and, on
approval, resolves the reference to the real value in place before the tool runs.

## How it works

```
.env / .env.local ──load──► in-memory registry { KEY: value }   (values held, never printed)
                                │
  before_agent_start ──────────┤  advertise KEY NAMES only to the model
                                │
  tool_call (any tool) ────────┘  find $KEY refs → approval popup → resolve in place
```

- **bash** — values are shell-quoted (`'…'`) so the command string stays safe.
- **all other tools** (read, grep, find, write, custom) — raw value substituted.
- **No UI / unattended** — injection is blocked, not silently leaked.

## Which tools does it work on?

**Any tool**, not just the `pix-*` suite. Resolution runs on the host `tool_call`
event and mutates `event.input` in place, so it applies to every registered
tool — Pi built-ins, custom tools, and the MCP proxy alike. The only
requirement is that the `$KEY` / `${KEY}` reference sits in a **string field**
of the tool's input (nested objects and arrays are walked). A tool that takes
no string input, or that reads its arguments from somewhere other than the
call input, cannot be brokered.

## Unattended modes (AFK / YOLO)

pix-env honours the same `__pixAfk` / `__pixYolo` globals as pix-sudo and
pix-ssh (set via the unattended toggle in pix-commands):

- **AFK** (and not YOLO) — injection is **auto-denied**. No secret is resolved
  while you are away.
- **YOLO** — injection is **auto-approved** without the popup, with a warning
  notification naming the keys. Use only when you accept unattended secret
  resolution.
- **Normal** — the approval popup is shown per tool call, including a leak
  warning (see below).

## Install

```bash
pi install npm:@xynogen/pix-env
```

> Standalone/opt-in — **not** bundled by [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core). It wires secret injection into tool calls, so you enable it deliberately.

## Usage

On session start it loads `.env` and `.env.local`
from the current directory. The model is told, once:

> Secret env vars available (VALUES HIDDEN)… reference them as `$KEY` or `${KEY}`.

Then the model can write, e.g.:

```
curl -H "Authorization: Bearer $API_KEY" https://api.example.com/me
```

The transcript shows `$API_KEY`; the real token only reaches the child process
after you approve the popup.

## Configuration

- `PIX_ENV_FILES` — comma-separated list of files to load, overriding the
  `.env`, `.env.local` default (e.g. `PIX_ENV_FILES=.env,.env.prod`).

## Guarantee and its limit

**Guaranteed:** the model authors `$KEY`, never the value; resolution is gated by
an explicit approval popup per tool call.

**Accepted limitation:** once resolved into a tool's input, the value can appear
in that tool's rendered call or output if the tool echoes it back
(`echo $TOKEN`, `curl -v`, an error dump). pix-env does **not** scrub tool
output. The approval popup warns about this per call. If you need scrubbing, the
upgrade path is a `tool_result` redactor that masks known registry values back
to `$KEY` — see the header note in `src/lib.ts`.

Other known limits:

- **String fields only** — a `$KEY` embedded in a non-string argument (number,
  boolean) is not resolved.
- **cwd-scoped load** — files are read from the session's working directory at
  start; secrets defined elsewhere are not seen.
- **No re-load** — editing `.env` mid-session does not refresh the registry;
  restart the session.
- **Read gating is separate** — pix-gate blocks the model from *reading* real
  `.env` files (`.env.example` and friends are allowed). pix-env only governs
  *injecting* their values into tool calls.

## License

MIT
