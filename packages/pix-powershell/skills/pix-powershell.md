---
name: pix-powershell
description: How to use `powershell` on native Windows — same rendering and truncation contract as `bash`, plain-text output, and the `&&` / `||` rewrite that applies only on Windows PowerShell 5.1. Use for shell commands on Windows instead of `bash`.
disable-model-invocation: true
---
# powershell — Windows shell execution

Registered only on native Windows; elsewhere the tool does not exist and `bash` is the shell. Execution is Pi's own PowerShell tool: `pwsh.exe` when present, else Windows PowerShell 5.1.

## Input

`{ "command": "...", "timeout": seconds }`. The command runs in the current directory; it waits for exit.

## What this wrapper changes

- **Plain text.** Every command is prefixed with `$PSStyle.OutputRendering = 'PlainText'`, so table headers and errors do not carry ANSI colour into the transcript. No-op on 5.1.
- **`&&` / `||` on 5.1.** Top-level chains are rewritten to `$?` checks and a failed chain still exits non-zero. The output then starts with `[pix-powershell] … rewrote && / ||`, which is a notice, not an error. Operators inside strings, comments, here-strings, and `( [ {` blocks are left alone.
- **Output limit.** Truncated to the last 2000 lines or 50KB; the full output goes to a temp file named in the result.

## Pick the tool

| Job | Tool |
|---|---|
| server, watcher, worker | `proc` |
| command that exits | `powershell` on Windows, `bash` elsewhere |
| root / Administrator on this machine | `sudo_run` (POSIX only) |
| remote host | `ssh_run` |

## Do not

- Assume `bash` exists on Windows, or `powershell` outside it.
- Retry a rewritten chain because of the notice line. Read the exit code and the real error.
