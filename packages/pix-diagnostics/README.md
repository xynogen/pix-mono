# pix-diagnostics

Pi extension — lightweight file-touched widget.

## What it does

Registers a compact widget on the `pi-lens` widget id, overriding the external pi-lens package when both are installed.

- Tracks files touched this session via `write`/`edit` tool results.
- Renders one line: up to 3 most-recently-touched basenames + `+N more`, plus a hint to run `/lens-booboo` for full details.
- State is per-session, cleared on `session_shutdown`.

> Does **not** yet query live LSP diagnostics (needs a full LSP client) — the file list is a placeholder for future LSP integration.

## Install

```bash
pi install npm:@xynogen/pix-diagnostics
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
