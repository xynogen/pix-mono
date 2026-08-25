# pix-grep

Pi tool — pattern search in files with FFF acceleration.

## What it does

Replaces Pi's default `grep` tool with an enhanced version backed by `pix-pretty`.

- **FFF lifecycle** — owns the frecency-ranked, SIMD-accelerated file index: inits on `session_start`, tears down on `session_shutdown`.
- **Constrained searches** (`path`/`glob` set) skip FFF and use the SDK's ripgrep directly, avoiding a known FFF 0.5.2 abort on Unicode filenames. Falls back to plain ripgrep if `@ff-labs/fff-node` isn't installed.
- **Rendering** — match-count header, highlighted pattern, file paths + line numbers, dim inline preview. Call labels show pattern, path, glob.
- **Pagination** — when more matches exist than returned, the result carries a `cursor` id and a `Use cursor="…" to continue` notice.

## Auto-collapse

After a configurable delay (default 10 seconds), completed output collapses to a row such as `✓ grep tickCollapse · 12 matches`. Structured failures use a compact `✗` row after the delay. Expanding restores the existing bounded match preview or exact diagnostic without restarting the elapsed timer. This is controlled via the `collapse` section of `~/.pi/agent/pix.json`:

```jsonc
{
  "collapse": {
    "enabled": true,
    "delaySec": 10,
    "tools": { "grep": true }
  }
}
```

Set `collapse.tools.grep: false` to disable for this tool only. See `@xynogen/pix-runtime/collapse` for the full API.

## Install

```bash
pi install npm:@xynogen/pix-grep
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
