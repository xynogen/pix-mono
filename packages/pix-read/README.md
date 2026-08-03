# pix-read

Pi tool — file read with syntax highlighting.

## What it does

Replaces Pi's default `read` tool with an enhanced version backed by `pix-pretty`. File content is syntax-highlighted using `cli-highlight` (highlight.js-backed) with language auto-detection. The call label shows the shortened file path, with optional `from line N` and `(N lines)` hints. Images are displayed with mime type and byte size and a type icon. Long files are shown with a line count and truncation notice; expanded mode reveals the full content. Depends on `@xynogen/pix-pretty`, installed automatically as a dependency.

## Auto-collapse

After a configurable delay (default 10 seconds), completed output collapses to a row such as `✓ read src/index.ts · 120 lines`. Structured failures use a compact `✗` row after the delay. Expanding recomputes and restores the normal bounded preview or exact diagnostic without restarting the elapsed timer. This is controlled via the `collapse` section of `~/.pi/agent/pix.json`:

```jsonc
{
  "collapse": {
    "enabled": true,
    "delaySec": 10,
    "tools": { "read": true }
  }
}
```

Set `collapse.tools.read: false` to disable for this tool only. See `@xynogen/pix-runtime/collapse` for the full API.

## Install

```bash
pi install npm:@xynogen/pix-read
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
