---
name: pix-bash
description: How to use `bash` without burning a turn — pick the right tool first (proc for servers, the mapped tool instead of a shell workaround), set a timeout, and read truncation and exit codes correctly. Use before any shell command, and after a `bash` call timed out or was truncated.
disable-model-invocation: true
---
# bash — shell execution

`bash` waits for the command to exit. A dev server, watcher, or `sleep` poll never exits, so it stalls the turn and then times out.

## Pick the tool before you type a command

| Job | Tool |
|---|---|
| dev server, `--watch`, worker, anything that keeps running | `proc` |
| VCS, package manager, build, test, linter, app CLI | `bash` |
| list a directory | `ls` |
| find files by glob | `find` |
| search file contents | `grep` |
| read a file | `read` |
| root on this machine | `sudo_run` |
| anything on a remote host | `ssh_run` |

Do not chain a mapped tool (`ls`, `cat`, `rg`, `find`) into `bash` to skip its check. `cmd | grep x` on a command's own output is fine.

## Input

`{ "command": "..." }`, plus `timeout` in seconds for slow builds and test suites.

## Output

- Truncated to the last 2000 lines or 50KB, whichever comes first. The full output goes to a temp file named in the result, so a truncation notice is not a failure: narrow the command instead of retrying it.
- A non-zero exit code is a failure result with stdout and stderr. Read the first error, fix it, then rerun.
- The framed block shows exit code, line count, and duration. Long output collapses to `✓ bash ... · exit 0 · N lines` after the collapse delay; expanding restores it.

## Gates: typecheck and tests

Typical agent output, and what it costs:

```bash
cd repo && bun run typecheck 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -cE "error TS"; bun run test 2>&1 | grep -E "^ *[0-9]+ (pass|fail|skip)"
```

- `sed` strips colour that can be disabled at the source.
- `grep -cE` counts matching *lines*, not errors, and throws away the message and file:line a fix needs.
- `;` runs the tests even when `cd` or the typecheck failed.
- Without `pipefail` the pipeline exits with grep's status, not the build's: a failure can read as success.
- `grep` drops the crash, the stack, and the failing test name.

Disable colour at the source and let the gate keep its exit code:

```bash
cd repo || exit 1
set -o pipefail
NO_COLOR=1 bun run typecheck
NO_COLOR=1 bun run test
```

When only a verdict is needed, keep the output only on failure:

```bash
cd repo || exit 1
for task in typecheck test; do
  out=$(NO_COLOR=1 bun run "$task" 2>&1); status=$?
  if [ "$status" -eq 0 ]; then
    printf '%s: PASS\n' "$task"
  else
    printf '%s: FAIL (%d)\n%s\n' "$task" "$status" "$out"
    exit "$status"
  fi
done
```

Three modes, one rule: never trade diagnostics for brevity.

| Mode | Output |
|---|---|
| verify | exit status plus `PASS` / the failure text |
| debug | full errors with the first failing case intact |
| CI | complete logs, original exit status |

`NO_COLOR=1` is a convention, not a guarantee: a script may still emit ANSI, and when `FORCE_COLOR` is set in the environment, Node ignores `NO_COLOR` and prints a warning on stderr. Prefer the tool's own `--no-color` or `CI=1` when it has one.

## Do not

- Use `&`, `nohup`, or `sleep` polling for a long-running command. Use `proc`.
- Use `sed -i`, `echo >`, or a heredoc to change a file. Use `edit` (existing file) or `write` (new file).
- Retry a failing command unchanged. Read the error first.
- Strip ANSI with `sed`, count errors with `grep -c`, or hide a gate behind a pipe. Disable colour at the source and keep the exit code.
