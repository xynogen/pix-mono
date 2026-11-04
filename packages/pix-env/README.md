<!-- markdownlint-disable MD013 MD040 -->

<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-env

Broker `.env` secrets to tools without ever putting the values in the model's context.

The AI sees only the key names. It writes `$KEY` / `${KEY}` in any tool
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

- **bash** — an `export KEY='value'` prelude (shell-quoted) is prepended and the
  references are left intact, so bash performs every expansion form natively:
  `$KEY`, `${KEY}`, and parameter-expansion modifiers (`${KEY%/}`, `${KEY:-x}`,
  `${KEY#p}`, `${KEY/a/b}`, …).
- **all other tools** (read, grep, find, write, custom) — the raw value is
  substituted for plain `$KEY`/`${KEY}`. There is no shell to expand modifiers,
  so a `${KEY%/}` in a non-bash tool is blocked with a nudge to use plain `$KEY`.
- **No UI / unattended** — injection is blocked, not silently leaked.

## Which tools does it work on?

Any tool, not just the `pix-*` suite. Resolution runs on the host `tool_call`
event and mutates `event.input` in place, so it applies to every registered
tool: Pi built-ins, custom tools, and the MCP proxy. The only
requirement is that the `$KEY` / `${KEY}` reference sits in a string field
of the tool's input (nested objects and arrays are walked). A tool that takes
no string input, or that reads its arguments from somewhere other than the
call input, cannot be brokered.

## Unattended modes (AFK / YOLO)

pix-env reads the shared unattended mode from `@xynogen/pix-runtime`, like
pix-sudo and pix-ssh (set with `/afk` and `/yolo` from pix-commands):

- **AFK** (and not YOLO) — injection is auto-denied. No secret is resolved
  while you are away.
- **YOLO** — injection is auto-approved without the popup, with a warning
  notification naming the keys. Use only when you accept unattended secret
  resolution.
- **Normal** — the approval popup is shown per tool call, including a leak
  warning (see below).

## Usage

It loads `.env` and `.env.local` from the current directory. The registry is
loaded per directory on first use and cached. Before each agent turn, the model is told:

> Secret env vars available (VALUES HIDDEN)… reference them as `$KEY` or `${KEY}`.

Then the model can write, e.g.:

```
curl -H "Authorization: Bearer $API_KEY" https://api.example.com/me
```

The transcript shows `$API_KEY`; the real token only reaches the child process
after you approve the popup.

### `read_env` tool

The model can also manage env files directly, with approval:

| Action | Effect |
|---|---|
| `info` | Lists key names and value types (`boolean`, `int`, `float`, `string`). No values. |
| `read` | Reveals only the requested `names` after an approval popup. Approved values enter the model context and transcript. |
| `add` / `edit` | Writes one `name`/`value` to a `.env` or `.env.<suffix>` file at `path` after an approval popup. Other assignments are kept. |

`path` defaults to the configured files for `info` and `read`. It is required for `add` and `edit`. Every disclosure and write needs an interactive UI.

## Configuration

- `PIX_ENV_FILES` — comma-separated list of files to load, overriding the
  `.env`, `.env.local` default (e.g. `PIX_ENV_FILES=.env,.env.prod`).

## Guarantee and its limit

**Guaranteed:** the model authors `$KEY`, never the value; resolution is gated by
an explicit approval popup per tool call.

**Accepted limitation:** once resolved into a tool's input, the value can appear
in that tool's rendered call or output if the tool echoes it back
(`echo $TOKEN`, `curl -v`, an error dump). pix-env does not scrub tool
output. The approval popup warns about this per call. If you need scrubbing, the
upgrade path is a `tool_result` redactor that masks known registry values back
to `$KEY` (see the header note in `src/lib.ts`).

Other known limits:

- **String fields only** — a `$KEY` embedded in a non-string argument (number,
  boolean) is not resolved.
- **Modifiers are bash-only** — parameter-expansion forms (`${KEY%/}` etc.) work
  in the bash tool via the export prelude, but are blocked in every other tool
  since those have no shell to expand them.
- **cwd-scoped load** — files are read from the working directory; secrets
  defined elsewhere are not seen.
- **Cached per directory** — editing `.env` outside pix-env mid-session does not
  refresh the cached registry; restart the session. A `read_env` write clears
  the cache.
- **Read gating is separate** — pix-gate blocks the model from *reading* real
  `.env` files (`.env.example` and friends are allowed). pix-env only governs
  *injecting* their values into tool calls.
- **Unknown keys pass through literally** — resolution only fires for keys that
  are in the registry (`reg.has(key)`). A `$KEY` whose name is *not* loaded from
  the configured env files produces no ref, so no popup and no block: the literal
  string `$KEY` reaches the child process unchanged. In bash it may then be
  expanded (or not) by the shell's own environment. Symptom seen in the wild:
  passing `$RFID_API_HOST` when `RFID_API_HOST` was never loaded into pix-env
  left the literal `$RFID_API_HOST/api/v1/...` in the command, and Python's
  urllib raised `unknown url type: '$RFID_API_HOST/...'`. Fix: make sure the key
  is actually in `.env`/`.env.local` under the session cwd (or `PIX_ENV_FILES`)
  so it enters the registry — check the startup "Secret env vars available" list.
- **No-UI blocks, does not leak** — for keys that *are* in the registry, an
  unattended/no-UI context auto-denies injection (the tool call is blocked with
  a reason), rather than resolving silently. Run from an interactive Pi session
  and approve the popup, or use YOLO mode to auto-inject.

## Install

```bash
pi install npm:@xynogen/pix-env
```

> Standalone and opt-in. [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core) does not bundle it. It reads local `.env` values and injects them into tool calls.

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
