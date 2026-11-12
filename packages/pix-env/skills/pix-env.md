---
name: pix-env
description: How to use `read_env` and broker `.env` secrets — inspect keys without exposing values, reference `$KEY` in any tool argument, and let approval resolve it at call time. Use before any command or request that needs a credential, or to add/update a key in a .env file.
disable-model-invocation: true
---
# read_env — .env inspection and brokered secrets

Values never enter the model's context. The model sees key names only and writes `$KEY` / `${KEY}` in any tool argument; the host resolves it on `tool_call` after an approval dialog.

## Input

`{ "action": "info" | "read" | "add" | "edit", "path": ".env", "names": ["API_KEY"], "name": "APP_PORT", "value": "8080" }`

| Action | Needs | Returns |
|---|---|---|
| `info` | optional `path` (file or directory) | names and types only |
| `read` | `names` | only the requested values, after approval |
| `add` | `path`, `name`, `value` | creates the key |
| `edit` | `path`, `name`, `value` | updates an existing key |

- `path` accepts `.env` or `.env.<suffix>`, including `.env.examples`. `info`/`read` also accept a directory and default to the configured files.
- `name` must match `^[A-Za-z_][A-Za-z0-9_]*$`. `value` is single-line text.

## Prefer the broker over `read`

Do not reveal a secret to use it. Write `$KEY` in the tool argument:

- In `bash`, the reference is left intact and a quoting prelude is prepended, so every shell form works: `$KEY`, `${KEY}`, `${KEY%/}`, `${KEY:-x}`.
- In every other tool, the raw value is substituted for plain `$KEY` / `${KEY}`, because there is no shell to expand modifiers. A `${KEY%/}` there is blocked and nudged back to the plain form.

Resolution is gated: the dialog appears per call, `/afk` denies it while you are away, `/yolo` resolves without asking. A supplied `value` does enter the transcript; use `$KEY` for an existing secret instead.

## Do not

- Request unrelated variables. Ask for the exact keys the task needs.
- Print, echo, or log a resolved value into a file or a result.
- Bypass the gate by copying a value from `read` into another call.
