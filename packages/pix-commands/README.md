# pix-commands

Pi extension providing focused slash commands:

- `/clear` — flush Pi's cached model data.
- `/btw [--no-ctx] <question>` — ask a side question without interrupting the main agent. It sees recent main-session turns by default (`--no-ctx` runs it fully isolated).
- `/afk` — toggle AFK mode for unattended runs (yellow auto-allow, red/root auto-deny).
- `/yolo` — toggle YOLO mode for unattended runs (auto-approve nearly everything incl. red/root; capable models only, session consent required).

## `/clear`

Deletes `~/.cache/pi` and the jiti transpile cache (`<tmpdir>/jiti`) to flush stale model data and compiled extensions. Other files in the temp dir stay. A confirm dialog lists the exact paths first. Choose **Delete** to go on, or **Cancel** / `esc` to stop. After it deletes, it prompts you to run `/reload`. Without a TUI (headless or RPC) it deletes with no prompt.

## `/btw`

`/btw` runs a separate in-memory child session concurrently with the main agent:

```text
/btw given what we just did, what should I test first?
/btw --no-ctx what is the difference between a mutex and a semaphore?
```

Run `/btw` with no question to print usage. The live
above-editor widget lingers finished asides for `collapse.delaySec × 3` (errors
`× 9`), so a fire-and-leave aside stays visible while you are away; the durable
answer card in the log never expires.

The child session:

- starts a fresh in-memory session with a lean Pix system prompt;
- snapshots the main session's model, thinking level, active tools, credentials, extensions, and working directory;
- gets the last 10 main-session turns as a one-shot, read-only text preamble (user and assistant text only, tool output dropped). It is still a fresh in-memory session, and nothing goes back to the main thread. Pass `--no-ctx` to send no main conversation;
- publishes its Markdown answer in a visually distinct side-thread card;
- keeps rendered BTW answers out of future main-agent LLM context;
- supports multiple concurrent side questions.

When the main agent is streaming, completion is shown as a notification and the durable card is appended after the main session becomes idle. This prevents the side answer from becoming steering input.

## `/afk`

`/afk` toggles AFK mode (away-from-keyboard) for unattended runs. It is a shared
toggle stored in a global flag and shown in the status bar.

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
are away, without silently permitting destructive ones. It pairs with the herdr
notification bridge in `pix-runtime`: you still get pinged when something truly
needs you (a red gate or root), and auto-deny turns that into a stop rather than
an approval.

## `/yolo`

`/yolo` toggles YOLO mode: **almost** every permission gate auto-approves,
**including red (critical) commands and root (`sudo_run`)**. For the vast
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
  bomb — is exempt from *every* mode, including YOLO (see
  [`pix-gate`](https://www.npmjs.com/package/@xynogen/pix-gate)). This does **not**
  forbid the command: a genuine `dd`-to-USB or `mkfs` still runs, it just falls
  back to a one-time Allow/Deny prompt instead of a silent auto-approve. One
  extra click, only under YOLO, only on the handful of commands you can't undo.
  Mirrors Claude Code's `bypassPermissions` floor.

`/afk` and `/yolo` are mutually exclusive; turning one on turns the other off.

### Mode awareness (both modes)

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

## Install

```bash
pi install npm:@xynogen/pix-commands
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

MIT. See [LICENSE](LICENSE).
