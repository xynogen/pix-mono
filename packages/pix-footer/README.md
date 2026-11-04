<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-footer

Pi extension — status bar footer.

## What it does

Renders a persistent status bar at the bottom of the Pi TUI, showing:

- Current mode.
- Working directory with git branch (dirty/ahead/behind markers).
- Session token counts (in/out), context usage %, session cost, active model, thinking level, model price, and benchmark score.
- Live tokens-per-second (TPS) during streaming, held 4s after the turn ends.
- Extension statuses (e.g. plan mode) as right-side segments.

The session cost shows as `~$` when it includes catalog estimates instead of provider-billed totals.

Model spec (context window, pricing, benchmark score) comes from the cached model catalogs in Pi's cache directory via `pix-data`.

Each segment can be shown or hidden in the `pretty.footer` section of `~/.pi/agent/pix.json`, or in the `/pix` Footer settings: `mode`, `cwd`, `git`, `context`, `model`, `thinking`, `price`, `score`, `statuses`, `tokens`, `cost`, `tps` (all on by default). `wrap` (off by default) wraps a footer that does not fit on one line.

## Install

```bash
pi install npm:@xynogen/pix-footer
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
