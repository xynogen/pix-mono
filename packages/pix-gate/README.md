<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-gate

Pi extension — permission gate for dangerous bash commands.

## What it does

Intercepts every tool call and classifies it against severity rules before it runs. Two rule sets:

**Path rules** — protect `read`/`write`/`edit`/`grep`/`find`/`ls` (and paths inside shell commands) from private keys, credential files, etc.

| Tier | Behavior |
|---|---|
| `block` | deny-first, 15s timeout |
| `warn` | allow-first, 30s |
| `info` | blue notify, never blocks |

**Command rules** — gate shell invocations (`bash`, `powershell`, `proc`).

| Tier | Examples | Behavior |
|---|---|---|
| `critical` | force-push to main, recursive delete, `dd` to disk | hard-block (non-interactive) / 15s auto-deny dialog (TUI) |
| `dangerous` | destructive git, `chmod 777`, `curl … \| sh` | 30s auto-deny confirmation |
| `risky` | — | 60s allow-first dialog; silently passes non-interactive |

**Privileged auth redirect** — bash `sudo`/`ssh` can't have their password/passphrase auto-typed, so they are hard-blocked and redirected to the dedicated tool (`sudo_run`/`ssh_run`) with no bypass, but *only when that tool is installed* (pix-sudo/pix-ssh are opt-in; without them the bash form is the only path and passes through). This is **guarding** (stop + redirect); the softer **steering** of non-privileged stand-ins (`cat`→`read`, `grep`→`grep`, …) lives in [`pix-nudge`](https://www.npmjs.com/package/@xynogen/pix-nudge).

Auto-approve patterns and extra rules go in the `gate` section of `~/.pi/agent/pix.json`; set `guardrails: "off"` to disable built-in rules entirely.

**Away notifications** — while a dialog is open, the gate holds the shared **agent-state** coordinator `blocked` (via `withAgentBlock` from [`@xynogen/pix-runtime`](https://www.npmjs.com/package/@xynogen/pix-runtime)), so [`pix-notify`](https://www.npmjs.com/package/@xynogen/pix-notify) can alert an away user. Pairs with the session modes below:

- `/afk` — yellow gates auto-allow, red/root auto-deny, so only stops requiring attention surface.
- `/yolo` — every tier including red auto-approves (capable models only).

Bare `sudo` in bash is always redirected to `sudo_run`, regardless of mode.

**Circuit breaker.** A small set of catastrophic, unrecoverable commands (`rm -rf /` or `~`, `dd`/redirect onto a raw disk, `mkfs` on a device, a fork bomb) can never be auto-approved by any mode, including YOLO. They always fall through to the interactive dialog (or a no-UI block). This mirrors Claude Code's `bypassPermissions` floor, which still prompts on root/home wipes.

**Project trust.** Replaces Pi's five-choice project-trust prompt with two remembered choices: **Trust** and **Do not trust**. Saved decisions, a `defaultProjectTrust` other than `ask`, and no-UI runs fall through to Pi unchanged.

## Session modes

`/afk`, `/yolo` and `/nuclear` set the session-only mode that every gate reads. Each shows a status-bar badge; turning one on turns the others off; `/new` resets to off.

### `/afk`

`/afk` toggles AFK mode (away-from-keyboard) for unattended runs. It is a shared
session-only toggle shown in the status bar.

When ON, yellow (medium-risk) permission gates auto-allow, while red (dangerous)
gates and sudo prompts auto-deny:

```text
AFK mode on — yellow gates auto-allow; red and sudo auto-deny.
```

When OFF (the default), normal approval prompts are restored:

```text
AFK mode off — approval prompts restored.
```

The point is to let the agent keep working on safe, medium-risk actions while you
are away, without silently permitting destructive ones. It pairs with
[`pix-notify`](https://www.npmjs.com/package/@xynogen/pix-notify): you still get
a sound when something needs you (a red gate or root), and auto-deny turns
that into a stop rather than an approval.

### `/yolo`

`/yolo` toggles YOLO mode: almost every permission gate auto-approves,
including red (critical) commands and root (`sudo_run`). For the vast
majority of actions there is no human confirming, so a destructive or
irreversible action can run before anyone stops it. Use it only when you accept
that. A few things still stop you — the four guardrails below are the deliberate
exceptions to "auto-approve everything."

```text
YOLO mode on (model score 82) — every gate including red and root auto-approves.
```

Four guardrails temper the blast radius:

- **One-time session consent.** The first `/yolo` of each session opens a
  blocking modal spelling out the damage risk and the AS-IS/no-liability
  disclaimer; you must explicitly accept before YOLO arms. Cancel leaves the
  normal prompts in place. Consent is session-scoped — a fresh session asks
  again, so arming YOLO is always a conscious act, never a forgotten flag.

- **Capable models only.** YOLO refuses to turn on unless the active model has a
  benchmark score of at least `75` (from `pix-data`). A weaker or off-catalog
  model is rejected with a message, because auto-approving red and root demands a
  model that reasons well about consequences.
- **Root still needs a ticket.** `sudo_run` auto-approves only when a valid PAM
  ticket is already cached — the password cannot be auto-typed, so a first root
  command with no cached ticket still shows the password prompt. Bare `sudo` in
  `bash` is always redirected to `sudo_run`, never run directly.
- **Circuit breaker.** A short list of catastrophic, unrecoverable commands —
  `rm -rf /` or `~`, `dd`/redirect onto a raw disk, `mkfs` on a device, a fork
  bomb — is exempt from *every* mode, including YOLO (see **Circuit breaker**
  above). This does not
  forbid the command: an intentional `dd`-to-USB or `mkfs` still runs, it just falls
  back to a one-time Allow/Deny prompt instead of a silent auto-approve. One
  extra click, only under YOLO, only on the handful of commands you can't undo.
  Mirrors Claude Code's `bypassPermissions` floor.

#### Mode awareness (both modes)

A relaxed gate is dangerous mainly because the *model* keeps acting as if a human
will still catch a bad call. To close that gap, while either mode is active a
short banner is injected into every turn via `before_agent_start`, telling the
model the safety net is off and what it now owns:

- **AFK** — plan around auto-deny of red and root; do not depend on a denied step
  succeeding; stop and summarize when a denial blocks progress.
- **YOLO** — before any red or root action, state in the reply why it is
  necessary, its blast radius and worst-case fallout, and whether it is
  reversible; if it cannot be justified, do not run it; always prefer the least
  destructive path.

The banner is only present while a mode is on, so it costs no baseline tokens
otherwise.
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

## Install

```bash
pi install npm:@xynogen/pix-gate
```

> Bundled in [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core). Install it alone only if you do not use pix-core.

## Full distro

This package is part of [Pix](https://github.com/xynogen/pix-mono). The installer sets up Pi and the full distro. See [Install](https://github.com/xynogen/pix-mono#install) for the notes for each OS.

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.ps1 | iex
```

## License

MIT
