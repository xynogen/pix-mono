# pix-sudo

Pi tool — `sudo_run` with interactive PAM password prompt.

## What it does

Registers the `sudo_run` tool, which executes shell commands as root behind a permission dialog (the shared overlay component from `@xynogen/pix-pretty`). Every command requires explicit per-call Allow/Deny approval in the UI, with a 60-second auto-deny timeout (dead-man's switch) — that approval step is never skipped. The dialog shape depends on PAM's sudo ticket cache: if a valid cached ticket exists (`sudo -n true`), the tool shows a confirm-only dialog (Allow/Deny, body notes "sudo session active") and runs with an empty password; if no valid ticket exists, it runs the two-stage flow — Allow/Deny first, then a masked password input (`●` per character). The password is passed to the lightweight `sudo -S -v` validation command via stdin, never written to disk; pix-sudo itself stores nothing. After validation refreshes sudo's PAM ticket, the requested command runs separately without keeping the overlay stuck on “Checking password…” for the command's duration. The ticket cache is the kernel/PAM tty timestamp (default ~15 min, OS-managed sudoers timeout), so it only skips re-typing the password, never the approval. Output is truncated to 50 KB / 2000 lines. In non-interactive (RPC/JSON) mode the tool is blocked immediately with an error.

While the approval dialog is open, `sudo_run` holds the shared **agent-state** coordinator in the `blocked` state (via `withAgentBlock` from [`@xynogen/pix-runtime`](https://www.npmjs.com/package/@xynogen/pix-runtime)). Inside a herdr pane that fires a "needs attention" notification, so an away user is pinged when a root command is waiting on approval.

Completed calls collapse after the configured Pix delay into a status row such as `✓ sudo apt install ripgrep · exit 0 · 18 lines`; denied and timed-out calls use `⚡`, and nonzero exits use `✗`. Expanding the row restores the normal stdout/stderr or exact diagnostic without restarting the elapsed timer. Configure the delay with `collapse.delaySec` and the per-tool toggle with `collapse.tools.sudo` in `~/.pi/agent/pix.json`. Approval and masked-password overlays are never collapsed, and passwords are never included in result metadata or render state.

## Install

```bash
pi install npm:@xynogen/pix-sudo
```

## Full distro

Source: [github.com/xynogen/pix-mono](https://github.com/xynogen/pix-mono)

To install the complete pix suite (all packages + Pi itself):

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

## License

MIT
