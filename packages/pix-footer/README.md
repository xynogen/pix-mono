# pix-footer

Pi extension — status bar footer.

## What it does

Renders a persistent status bar at the bottom of the Pi TUI, showing:

- Current mode.
- Working directory with git branch (dirty/ahead/behind markers).
- Session token counts (in/out), context usage %, session cost, active model.
- Live tokens-per-second (TPS) during streaming, held 4s after the turn ends.
- Extension statuses (e.g. plan mode) as right-side segments.

Model spec (context window, pricing) comes from `~/.cache/pi/models-dev.json` via `pix-data`.

## Install

```bash
pi install npm:@xynogen/pix-footer
```

> Also included in [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core):
>
> ```bash
> pi install npm:@xynogen/pix-core
> ```

## Full distro

Source: [github.com/xynogen/pix-mono](https://github.com/xynogen/pix-mono)

To install the complete pix suite (all packages + Pi itself):

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

## License

MIT
