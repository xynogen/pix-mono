---
name: pix-ssh
description: How to use `ssh_run` for remote hosts — the right action per job (command, upload, download, read, write, edit, info), host aliases, remote sudo, and diagnosing connection failures. Use before any work on a remote machine.
disable-model-invocation: true
---
# ssh_run — remote hosts

Remote only. For the local machine use `bash`, or `sudo_run` for local root.

| Action | Required | Optional |
|---|---|---|
| `info` | — | `host` (omit = list aliases; set = effective config) |
| `command` | `host`, `command` | `sudo`, `fresh` |
| `upload` / `download` | `host`, `source`, `destination` | `recursive`, `fresh` |
| `read` | `host`, `path` | `offset`, `limit` |
| `write` | `host`, `path`, `content` | — |
| `edit` | `host`, `path`, `edits` | — |

Always set `reason`. `host` is `[user@]host[:port]` or an SSH config alias.

## Pattern

1. Unknown host or user: `info` first, never `read ~/.ssh/config`.
2. Change a remote file: `read` (it returns hash anchors), then `edit` with those anchors. `write` replaces the whole file. Anchors from another host or a local file never apply.
3. Several commands: join them in one `command` with `&&`. One call per step costs a round trip each.
4. Root on the remote: `sudo: true` on `command`. File actions (`read`/`write`/`edit`) run as the SSH user and never use sudo.

## Connection failures in history

| Message | Meaning | Next step |
|---|---|---|
| `Connection refused` | No SSH server on that port | Check the port with `info`; ask the user if the service is down. |
| `No route to host` / `timed out` | Network or VPN path is down | Report it. Do not retry in a loop. |
| `authentication failed` | Key not accepted, or wrong password | Use `fresh: true` once to re-authenticate; then ask the user. |
| `Remote sudo authentication failed` | Wrong remote sudo password | Ask the user. Never guess. |

## Do not

- Use `bash` with raw `ssh`, `scp`, or `rsync` for these jobs.
- Use `cat`, `sed -i`, or heredocs over `command` to change remote files.
- Retry a refused or unreachable host more than once.
