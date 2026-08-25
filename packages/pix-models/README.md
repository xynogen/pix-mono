# pix-models

Pi extension — enhanced `/models` picker with coding score/rank.

## What it does

Registers a `/models` slash command — a richer TUI picker replacing Pi's built-in `/model` selector.

- **Each row** — model id, context window, per-M-token cost, and a coding score/rank (star bar) when available.
- **Sorting** — by coding score (best first), then alphabetically for unscored models. Fuzzy search filters as you type.
- **Thinking level** — left/right cycles `off` → `minimal` → `low` → `medium` → `high` → `xhigh`, shown live in the header.
- **Select** — switches the active model for the session.

Model metadata comes from `~/.cache/pi/` via `pix-data`; the coding score/rank is computed locally from the modelgrep catalog (best = #1).

## Install

```bash
pi install npm:@xynogen/pix-models
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
