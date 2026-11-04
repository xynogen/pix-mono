<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-update

Pi extension — `/update` self-update command.

## What it does

Registers a `/update` slash command that updates Pi and refreshes all installed `@xynogen/pix-*` extensions. Updates Pi with Pi's own `pi update --self`, which detects the install method (Bun, npm, pnpm, or yarn), and wraps it in a retry loop that distinguishes transient errors (rate limits, timeouts, network failures) from hard failures. After updating Pi, runs `pi update --extensions` to refresh extensions from npm. The command shows a progress overlay, confirms the action upfront, and closes Pi at the end so the next launch picks up the new binaries.

Each step has a timeout of at least 300 seconds (`io.timeoutSec` in `~/.pi/agent/pix.json` wins when it is larger). A timed-out or killed step reports a failure, not success. If npm registry metadata is stale and some packages stay on an old version, `/update` shows a warning that names them. Start Pi with `--update` to queue `/update` at session start.

## Install

```bash
pi install npm:@xynogen/pix-update
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
