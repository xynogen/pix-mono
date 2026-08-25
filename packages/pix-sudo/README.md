# pix-sudo

Pi tool — `sudo_run` with interactive PAM password prompt.

## What it does

Registers the `sudo_run` tool — run shell commands as root behind a permission dialog (the shared overlay from `@xynogen/pix-pretty`). Every command needs explicit per-call Allow/Deny, with a 60-second auto-deny timeout. That approval is never skipped.

**Approval flow** — depends on PAM's sudo ticket cache:

- **Valid ticket cached** (`sudo -n true`) → confirm-only dialog (Allow/Deny, "sudo session active"), runs with an empty password.
- **No ticket** → two stages: Allow/Deny, then a masked password input (`●` per char).

The password goes to `sudo -S -v` via stdin — never written to disk, pix-sudo stores nothing. After the ticket refreshes, the command runs separately so the overlay isn't stuck on "Checking password…". The ticket is the kernel/PAM tty timestamp (~15 min OS default), so it only skips re-typing the password, never the approval.

Output is truncated to 50 KB / 2000 lines. In non-interactive (RPC/JSON) mode the tool is blocked immediately.

**Away notifications** — while the dialog is open, `sudo_run` holds the shared **agent-state** coordinator `blocked` (via `withAgentBlock` from [`@xynogen/pix-runtime`](https://www.npmjs.com/package/@xynogen/pix-runtime)), so a herdr pane pings an away user when a root command waits on approval.

**Unattended modes** (pix-commands):

- `/afk` — denies `sudo_run` immediately.
- `/yolo` — auto-approves **only when a valid PAM ticket is already cached** (a password can't be auto-typed, so a first uncached root command still prompts). Only the Allow/Deny is skipped; nothing else changes.

**Collapse** — completed calls collapse after the Pix delay into a row like `✓ sudo apt install ripgrep · exit 0 · 18 lines` (`⚡` denied/timed-out, `✗` nonzero exit). Expanding restores full stdout/stderr without restarting the timer. Configure via `collapse.delaySec` and `collapse.tools.sudo` in `~/.pi/agent/pix.json`. Approval and password overlays never collapse; passwords never appear in result metadata or render state.

## Install

```bash
pi install npm:@xynogen/pix-sudo
```

> Standalone/opt-in — **not** bundled by [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core). Root execution is a privileged capability, so you install it deliberately.

## Full distro

Source: [github.com/xynogen/pix-mono](https://github.com/xynogen/pix-mono)

To install the complete pix suite (all packages + Pi itself):

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

## License

MIT
