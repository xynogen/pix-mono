# pix-mcp

Token-efficient MCP gateway for the [Pix](https://github.com/xynogen/pix-mono)
Pi distro.

See the monorepo's root [README](../../README.md#lineage) for upstream lineage
and [LICENSE](LICENSE) for the retained MIT license.

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

### Pi mcp.json fields

Pix MCP reads these server fields from Pi's `mcp.json` format:

| Field | Effect |
|---|---|
| `description` | One line in the `mcp` tool server list and the codemode namespace. Without it, the namespace uses the first line of the server instructions. |
| `enabled: false` | Keeps the entry without connecting. `/mcp` shows it as `disabled`. Edit it there to enable it again. |
| `timeout` | Per-request timeout in seconds. Overrides `settings.requestTimeoutMs`. |
| `exposure` | `codemode` or `deferred` (default, found through `tool_search`), `direct` (declared to the model), or `hidden` (unreachable). `codemode-deferred` is an alias of `codemode`. |
| `toolExposure` | Per-tool exposure. Keys are tool names or `*` patterns. Exact names win, then the first matching pattern, then `exposure`. |
| `auth: { "provider": "<name>" }` | Sends the token of a Pi `/login` provider. Allowed only in `<Pi agent dir>/mcp.json`, for an `https` URL or `http` on `localhost`, `127.0.0.1`, or `[::1]`. |
| `"!command"` in `headers`, `env`, or `oauth.clientSecret` | Runs the command in `bash` (Git Bash on Windows) at connect time, with a 10 s timeout, and uses the trimmed stdout. A good result is cached until Pi restarts. A failure is retried on the next connect. |

`exposure` and `toolExposure` win over `directTools`. `MCP_DIRECT_TOOLS` wins over both, but a
`hidden` tool stays hidden. Pix MCP drops an invalid value and shows one warning line for it.
In `/mcp`, the direct-tools toggle writes `toolExposure` for a server that uses `exposure`, and
`directTools` for other servers.

Project files (`.mcp.json`, `.pi/mcp.json`) can start local commands through `command` and
`"!command"` values. Review a project's MCP config before you open it in Pi.

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

## Install

```bash
pi install npm:@xynogen/pix-mcp
```

> Standalone and opt-in. [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core) does not bundle it. External servers can run local commands, need credentials, or expose sensitive data.

Restart Pi after installation.

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

MIT. See [LICENSE](LICENSE).
