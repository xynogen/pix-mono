# @xynogen/pix-mcp

Token-efficient MCP gateway for the [Pix](https://github.com/xynogen/pix-mono)
Pi distro.

See the monorepo's root [README](../../README.md#lineage) for upstream lineage
and [LICENSE](LICENSE) for the retained MIT license.

## Install

```bash
pi install npm:@xynogen/pix-mcp
```

Restart Pi after installation.

> Standalone/opt-in — **not** bundled by [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core). External servers may require credentials, execute local commands, or expose sensitive data, so you enable it deliberately.

## Configure

Preferred project config: `.mcp.json`

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

`chrome-devtools` above is a generic, illustrative example of the config
shape — not a recommendation or endorsement. Any MCP server works; Pix stays
provider-neutral.

Preferred shared user config: `~/.config/mcp/mcp.json`.

Pix MCP also reads, in increasing precedence:

1. `~/.config/mcp/mcp.json`
2. `<Pi agent dir>/mcp.json`
3. `.mcp.json`
4. `.pi/mcp.json`

Run `/mcp setup` for guided discovery, or `pix-mcp init` to detect supported
Cursor, Claude, Codex, Windsurf, and VS Code configs.

## Token-efficient defaults

- One compact `mcp` proxy tool is exposed instead of every remote tool schema.
- Servers connect lazily and tool metadata is cached for seven days.
- `search` and server listing return bounded compact results by default.
- Schemas are loaded only with `describe`, or explicitly with
  `includeSchemas: true` on search.
- Large MCP results are truncated in context and written to a temporary file
  for targeted inspection.
- Direct tools remain opt-in because each one adds its schema to the baseline
  prompt.

### Gateway examples

```text
mcp({})
mcp({server: "github"})
mcp({search: "issue create", server: "github"})
mcp({describe: "github_create_issue"})
mcp({tool: "github_create_issue", args: "{\"owner\":\"acme\",\"repo\":\"app\",\"title\":\"Bug\"}"})
```

Search/list responses default to 12 items. Request up to 50 with `limit`:

```text
mcp({search: "issue", limit: 25})
```

Set `includeSchemas: true` only when a single discovery call really needs all
matching schemas; `describe` is usually smaller.

## Lifecycle

Servers default to `"lazy"`, disconnect after ten idle minutes, and reconnect
on the next call. Set a server's `lifecycle` to `"eager"` or `"keep-alive"`
only when startup connection or health-checked persistence is worth the cost.

Lazy servers are not connected merely to populate metadata at startup. Their
metadata is cached after the first explicit connection or call, and later
sessions can search, list, and describe valid cached metadata without a live
connection. Eager and keep-alive servers still connect at startup.

## Development

The test suite uses `bun:test` throughout:

```bash
bun run test
```

The suite uses `bun test --isolate` (see root `package.json`). This is
required because `mock.module()` is process-global and leaks between files
without isolation. The flag is intentionally on the default `bun test`
command so bare runs pass everywhere (`bunfig.toml` does not support
`[test].isolate` in Bun 1.3).

## Compatibility

The package preserves the upstream MCP transport, OAuth, sampling,
elicitation, MCP Apps/UI, resource, direct-tool, lifecycle, and output-guard
capabilities. Existing `.mcp.json` files remain compatible.
