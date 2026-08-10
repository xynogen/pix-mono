# pix-gate

Pi extension — permission gate for dangerous bash commands.

## What it does

Intercepts every `bash` tool call and classifies the command against a set of severity rules before it runs. Two rule sets: **path rules** (block / warn / info) protect the `read` / `write` / `edit` tools from touching private keys, credential files, etc. — `block` is deny-first (15s timeout), `warn` is allow-first (30s), `info` is a blue notify that never blocks. **Command rules** (critical / dangerous / risky) gate `bash` invocations: `critical` (force pushes to main, recursive deletes, `dd` to disks, etc.) is hard-blocked in non-interactive mode and hard-denied via a 15-second auto-deny dialog in TUI mode; `dangerous` commands (including any `sudo` invocation, which is hard-redirected to the `sudo_run` tool — no bypass) show a 30-second auto-deny confirmation dialog; `risky` commands show a 60-second allow-first dialog and silently pass in non-interactive mode. Auto-approve patterns and extra rules can be configured in the `gate` section of `~/.pi/agent/pix.json`. Built-in rules can be turned off entirely by setting `guardrails: "off"` in that section.

While an approval dialog is open, the gate holds the shared **agent-state** coordinator in the `blocked` state (via `withAgentBlock` from [`@xynogen/pix-runtime`](https://www.npmjs.com/package/@xynogen/pix-runtime)). Inside a herdr pane that fires a "needs attention" notification, so an away user is pinged when a command is waiting on approval. Pairs with the unattended modes in pix-commands: with `/afk` on, yellow gates auto-allow and red/root auto-deny, so only genuine stops surface; with `/yolo` on, every tier including red auto-approves (capable models only). Bare `sudo` in bash is always redirected to `sudo_run` regardless of mode.

**Circuit breaker.** A small set of catastrophic, unrecoverable commands — `rm -rf /` or `~`, `dd`/redirect onto a raw disk, `mkfs` on a device, a fork bomb — can never be auto-approved by any mode, including YOLO. They always fall through to the interactive dialog (or a no-UI block). This mirrors Claude Code's `bypassPermissions` floor, which still prompts on root/home wipes.

## Install

```bash
pi install npm:@xynogen/pix-gate
```

> Also included in [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core):
>
> ```bash
> pi install npm:@xynogen/pix-core
> ```

## Reusable exports

The gate is split into a pure rule engine and the interactive prompt, so the
classification logic can be reused without the TUI:

- `@xynogen/pix-gate/lib` — pure rules: `DEFAULT_RULES`, `buildRules`,
  `classify`, `loadUserConfig`, `isSudoCommand`. No Pi/TUI dependency.
- `@xynogen/pix-gate/prompt` — `promptGateDecision()`, the confirm/deny dialog
  (depends on `pi-tui`). This is now a thin adapter over the shared
  `@xynogen/pix-pretty/gate-overlay` component, so the gate and `sudo_run`
  dialogs share one implementation.

`pix-skills` imports `./lib` to gate skill `` !`cmd` `` directives with the same
rules as the bash tool (auto-deny on match, no prompt).

## Configuration

Gate rules are read from the **`gate` section of `~/.pi/agent/pix.json`** (the unified config file). The legacy `~/.pi/agent/pix-gate.json` file is no longer used.

`~/.pi/agent/pix.json` — `gate` section:

```jsonc
{
  "gate": {
    "guardrails": "on",
    "extraRules": [
      { "pattern": "rm -rf /my-dir", "severity": "critical", "reason": "Deletes project root" }
    ],
    "autoApprove": ["^echo "]
  }
}
```

The schema is identical to the old `pix-gate.json` — move your existing config into `pix.json` under the `gate` key.

## Full distro

Source: [github.com/xynogen/pix-mono](https://github.com/xynogen/pix-mono)

To install the complete pix suite (all packages + Pi itself):

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

## License

MIT
