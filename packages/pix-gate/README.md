# pix-gate

Pi extension — permission gate for dangerous bash commands.

## What it does

Intercepts every tool call and classifies it against severity rules before it runs. Two rule sets:

**Path rules** — protect `read`/`write`/`edit` from private keys, credential files, etc.

| Tier | Behavior |
|---|---|
| `block` | deny-first, 15s timeout |
| `warn` | allow-first, 30s |
| `info` | blue notify, never blocks |

**Command rules** — gate `bash` invocations.

| Tier | Examples | Behavior |
|---|---|---|
| `critical` | force-push to main, recursive delete, `dd` to disk | hard-block (non-interactive) / 15s auto-deny dialog (TUI) |
| `dangerous` | any `sudo` (hard-redirected to `sudo_run`, no bypass) | 30s auto-deny confirmation |
| `risky` | — | 60s allow-first dialog; silently passes non-interactive |

Auto-approve patterns and extra rules go in the `gate` section of `~/.pi/agent/pix.json`; set `guardrails: "off"` to disable built-in rules entirely.

**Away notifications** — while a dialog is open, the gate holds the shared **agent-state** coordinator `blocked` (via `withAgentBlock` from [`@xynogen/pix-runtime`](https://www.npmjs.com/package/@xynogen/pix-runtime)), so a herdr pane pings an away user. Pairs with pix-commands unattended modes:

- `/afk` — yellow gates auto-allow, red/root auto-deny, so only genuine stops surface.
- `/yolo` — every tier including red auto-approves (capable models only).

Bare `sudo` in bash is always redirected to `sudo_run`, regardless of mode.

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
