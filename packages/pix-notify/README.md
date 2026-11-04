<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-notify

Sound (and popup in herdr) when the agent waits on you: `ask_user`, a pix-gate
approval, `sudo_run`/`ssh_run`/Python/env approval.

It listens to `pix:agent-state` from `@xynogen/pix-runtime` and fires once per
entry into `blocked`, never repeatedly.

| Where | What happens |
|---|---|
| herdr pane + herdr's Pi integration (`herdr integration install pi`) | emits `herdr:blocked {active, label}` on enter/leave; herdr shows `blocked` in the sidebar and plays its own toast + sound (`[ui.toast]`, `[ui.sound]` in herdr's `config.toml`) |
| herdr pane, no integration | `herdr notification show <message> --sound request` |
| elsewhere, or herdr missing | plays a system sound with the OS's own player |

The integration is detected by its file, `<agentDir>/extensions/herdr-agent-state.ts`.

## System sounds — no ffmpeg

The OS ships both the sounds and the player:

| OS | Sounds | Player |
|---|---|---|
| Linux | `$XDG_DATA_DIRS/sounds/freedesktop/stereo` | `paplay` (or `pw-play`) |
| macOS | `/System/Library/Sounds` | `afplay` |
| Windows | `%SystemRoot%\Media` | PowerShell `Media.SoundPlayer` |

No sound or player found → silent.

## Settings — `/pix` → Notify

Stored in the `notify` section of `~/.pi/agent/pix.json`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Play a sound when the agent waits on you |
| `sound` | `"auto"` | `auto` (OS default), an installed system sound name, or a file path |

The tab also has a **test** row. In a herdr pane with the integration, herdr
owns the sound; change it in herdr's `config.toml`.

Bundled in `@xynogen/pix-core`.
