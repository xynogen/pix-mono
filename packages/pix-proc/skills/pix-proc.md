---
name: pix-proc
description: How to run dev servers, watchers, and other long-lived commands with `proc` instead of blocking `bash` — start, read logs, stop, and clean up. Use before starting any command that keeps running (dev server, `--watch`, a worker) or when you would otherwise poll with sleep.
disable-model-invocation: true
---
# proc — long-lived processes

`bash` waits for the command to exit. A server or watcher never exits, so in history it caused hundreds of `bash` timeouts. `proc` runs it in the background and returns a `proc-*` handle.

| Action | Fields | Result |
|---|---|---|
| `start` | `command`, `cwd?`, `name?` | handle plus the first output |
| `logs` | `handle`, `tail?` | new output since the last read, or the last `tail` lines |
| `list` | — | running processes |
| `stop` | `handle` | stops the process |
| `rm` | `handle` | removes a stopped process |

## Pattern

1. `start` the server. Read the first output for the URL or port and for startup errors.
2. Run checks with `bash` (`curl`, tests) while it runs.
3. Read `logs` after a request, not in a loop.
4. `stop` it when you are done, unless the user wants it to keep running.

## Do

- Use `proc` for: `npm/bun/pnpm run dev`, `vite`, `next dev`, `uvicorn`, `flask run`, `docker compose up` without `-d`, `tail -f`, any `--watch`.
- Give `name` when you run more than one process.

## Do not

- Run a server in `bash` with `&`, `nohup`, or a long `timeout`.
- Poll with `sleep` in `bash` or `codemode`. Call `logs` once when you need the output.
- Use `proc` for one-shot commands; `start` notices a fast exit and points back to `bash`.
