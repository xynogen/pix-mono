# pix-grep

Pi tool — pattern search in files with FFF acceleration.

## What it does

Replaces Pi's default `grep` tool with an enhanced version backed by `pix-pretty`. Owns the FFF (frecency-ranked, SIMD-accelerated file index) session lifecycle — initializes the finder on `session_start` and tears it down on `session_shutdown`. Constrained searches (`path` or `glob` set) skip FFF and use the SDK's ripgrep directly to avoid a known FFF 0.5.2 abort on Unicode filenames. Falls back to standard ripgrep if `@ff-labs/fff-node` is not installed. Results are rendered with a match-count header, the matched pattern highlighted, file paths and line numbers, and a dim inline preview. Call labels show the pattern, search path, and glob. When more matches are available than were returned, the result includes a `cursor` id and a `Use cursor="…" to continue` notice for paginating the rest. Depends on `@xynogen/pix-pretty`, installed automatically as a dependency.

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
