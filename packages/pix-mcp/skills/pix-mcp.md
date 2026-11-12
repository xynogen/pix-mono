---
name: pix-mcp
description: How to call MCP tools through the `mcp` proxy — discover with search/server, read a schema with describe, call with tool+args, and handle auth. Use before any MCP tool call, when a server or tool name is unknown, or when a call fails on arguments.
disable-model-invocation: true
---
# mcp — gateway to MCP servers

The proxy keeps MCP schemas out of context. Params select the mode:

| Goal | Params |
|---|---|
| status / configured servers | `{}` (no params) |
| find tools by name or description | `{ "search": "query" }` |
| one server's tools | `{ "server": "name" }` |
| a tool's schema | `{ "describe": "tool" }` |
| call a tool | `{ "tool": "name", "args": "{\"k\":1}" }` |
| connect / refresh a server | `{ "connect": "name" }` |
| auth | `{ "action": "auth-start" }`, then `{ "action": "auth-complete" }` |

- `args` is a **JSON object string**, not an object. A parse error there is a quoting mistake, not a tool error.
- Discovery is compact by default: `limit` caps results (default 12, max 50), `includeSchemas` adds schemas, `regex` treats `search` as a regex.
- `server` alone lists that server; with `search`/`tool` it filters.
- `connect` accepts ephemeral env via `{ "connect": "name", "args": "{\"env\":{\"KEY\":\"...\"}}" }`. Never put a secret in a persistent arg; use a `$KEY` reference.
- `{ "action": "ui-messages" }` reads results after an MCP UI window closed.

## Pattern

1. `search` (or `server`) for the tool you need.
2. `describe` it when the schema is unknown. Do it before a write call.
3. Call with `tool` + `args`.
4. On an auth error, `auth-start`, let the user finish in the browser, then `auth-complete`.

## Do not

- Guess a tool name or argument shape. Search and describe first.
- Dump a whole server's schemas into context (`includeSchemas` on a broad search). Ask for one tool.
