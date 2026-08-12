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

## Usage

Install the package into Pi. On session start it loads `.env` and `.env.local`
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
output. If you need that, the upgrade path is a `tool_result` redactor that masks
known registry values back to `$KEY` — see the header note in `src/lib.ts`.

## License

MIT
