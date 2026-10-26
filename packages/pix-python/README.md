# pix-python

Pi tool — `python_run`: run a local Python snippet behind an approval prompt.

## What it does

Models often push Python through `bash` (`python3 -c "…"`, `python3 - <<EOF`). That breaks on shell quoting and indentation, and the transcript shows a wall of shell. `python_run` is a cleaner front door for the same thing.

- **Parameters:** `intent` (short why, required), `code`, and optional `python`.
- **Not a sandbox.** The code runs as you, in the session cwd, with full file and network access.
- **Interpreter (`python`, optional):**
  - omitted → `python3` from `binary.json` (key `python3`), else PATH. An activated venv works when Pi was started inside it.
  - a venv or conda folder: `.venv`, `venv`, `~/envs/ml` → its `bin/python3` (`Scripts\python.exe` on Windows).
  - an interpreter file: `.venv/bin/python`, `/usr/bin/python3.12`.
  - a name on PATH: `python3.12`, `pypy3`.
  - Relative paths resolve against the session cwd. A missing path fails before the approval prompt, and the prompt shows the resolved interpreter.
- **Indentation repair before running:** CRLF → LF, markdown fences dropped, leading tabs → 4 spaces, the indent shared by all lines removed. Line numbers in tracebacks stay correct. The script goes in on stdin, so there is no shell quoting.
- **Approval** in the shared permission overlay (like `sudo_run`): intent, cwd, and the code. Choices: **Allow**, **Allow for this session** (until `/new` or `/reload`), **Deny**. 60 s idle auto-deny.
- **Unattended modes:** `/yolo` approves. `/afk` denies unless the session was already allowed. Without a UI the tool is blocked.
- **Card:** `python_run <intent>` with the highlighted code, then the output in the standard result frame. Completed calls collapse to `✓ python_run · <intent> · 3 lines · 120ms` (`collapse.tools.python_run` in `~/.pi/agent/pix.json`).
- Output keeps the tail (tracebacks end there), capped at Pi's default line/byte limits.

When `pix-nudge` is active, a standalone `python -c` / `python - <<` in bash gets a one-time hint toward `python_run`. Piped `… | python -c` stays in bash.

## Install

```bash
pi install npm:@xynogen/pix-python
```

> Standalone and opt-in. [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core) does not bundle it, because it runs arbitrary local code.

## License

MIT
