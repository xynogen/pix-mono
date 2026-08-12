# pix-ssh

Pi tool — `ssh_run`: run a shell command on a remote host over SSH, optionally as remote root.

## What it does

Registers the `ssh_run` tool, which executes a command on a remote machine behind a permission dialog (the shared overlay from `@xynogen/pix-pretty`, the same one pix-sudo uses). Every command requires explicit per-call Allow/Deny approval in the UI, with a 60-second auto-deny timeout — that approval step is never skipped. Output is truncated to 50 KB / 2000 lines. In non-interactive (RPC/JSON) mode the tool is blocked immediately.

**Parameters:** `host` as `[user@]host[:port]` (e.g. `deploy@10.0.0.5:2222`), `command`, optional `sudo` (run as root on the remote), optional `reason`.

### Authentication

- **SSH login** — tries key/agent/existing-master auth first via a `BatchMode=yes` probe. If that succeeds, no login password is needed. If it fails, a masked overlay (`●` per character) collects the login password, fed to `sshpass -e` through the child's `SSHPASS` env var — never as an argv (no `ps` leak), never written to disk.
- **Remote sudo** (`sudo: true`) — a separate masked prompt collects the remote sudo password, piped to the remote `sudo -S -p ''` on stdin, so it travels inside the encrypted SSH channel, not as an argv.

Both passwords are cached **in-memory per host** for the session (keyed by `user@host:port`), never persisted. A wrong login password drops the login cache; a wrong sudo password drops the sudo cache — the next call re-prompts.

### Connection reuse

OpenSSH **ControlMaster multiplexing** keeps one authenticated connection per host alive for a short `ControlPersist` window, so repeat `ssh_run` calls to the same host skip re-auth. Host-key policy is `accept-new` and `ConnectTimeout` is 10s.

While the approval dialog is open, `ssh_run` holds the shared **agent-state** coordinator in `blocked` (via `withAgentBlock` from [`@xynogen/pix-runtime`](https://www.npmjs.com/package/@xynogen/pix-runtime)), so an away user in a herdr pane is pinged when a command is waiting on approval. `/afk` (pix-commands) denies `ssh_run` immediately; `/yolo` auto-approves it only when no password is missing (a password prompt can't be auto-typed).

Completed calls collapse after the configured Pix delay into a status row such as `✓ ssh deploy@10.0.0.5  apt update · exit 0 · 12 lines`. Configure the delay with `collapse.delaySec` and the per-tool toggle with `collapse.tools.ssh` in `~/.pi/agent/pix.json`. Overlays are never collapsed, and passwords are never included in result metadata or render state.

## Requirements

- `ssh` (OpenSSH) on the local machine.
- `sshpass` on the local machine — only needed for password-based SSH login. Key-based auth works without it.

## Install

```bash
pi install npm:@xynogen/pix-ssh
```

## Full distro

Source: [github.com/xynogen/pix-mono](https://github.com/xynogen/pix-mono)

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

## License

MIT
