# pix-find

Pi tool — glob file search with FFF acceleration.

## What it does

Replaces Pi's default `find` tool with an enhanced version backed by `pix-pretty`. Uses FFF (frecency-ranked, SIMD-accelerated file finder) when available, falling back to the standard glob search. Results are rendered as a dim preview of the matched relative paths; the call label shows the glob pattern and search directory inline. The finder is shared with `pix-grep` (owned there) — install `pix-grep` alongside to actually populate the index. Depends on `@xynogen/pix-pretty`, installed automatically as a dependency.

## Auto-collapse

After a configurable delay (default 10 seconds), completed output collapses to a row such as `✓ find **/*.ts · 24 files`. Structured failures use a compact `✗` row after the delay. Expanding restores the existing bounded result list or exact diagnostic without restarting the elapsed timer. This is controlled via the `collapse` section of `~/.pi/agent/pix.json`:

```jsonc
{
  "collapse": {
    "enabled": true,
    "delaySec": 10,
    "tools": { "find": true }
  }
}
```

Set `collapse.tools.find: false` to disable for this tool only. See `@xynogen/pix-runtime/collapse` for the full API.

## Install

```bash
pi install npm:@xynogen/pix-find
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
