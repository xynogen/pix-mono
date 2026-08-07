---
name: composio-mcp
description: Use when calling Composio MCP tools (any app it proxies). Prefer a direct MCP server if one exists; introspect object shape before mutating; ask the user with options instead of guessing IDs, names, or field paths.
disable-model-invocation: true
---

# Composio MCP: introspect before you mutate

Field names, type names, and enum options differ per workspace and are not
guessable. Read the shape before you write — a guessed name burns a round-trip
or silently writes bad data.

## Rules

0. **Prefer a direct server over the proxy.** Before reaching for Composio, list
   configured servers with `mcp()` (no args) and check whether the target app
   has its own dedicated MCP server. If it does, use it — `mcp(server:"<app>")`
   to discover, then call the native tool directly. One native call typically
   replaces the whole Composio
   `SEARCH_TOOLS → GET_TOOL_SCHEMAS → REMOTE_WORKBENCH → EXECUTE` chain. Composio
   is the fallback only for apps with no direct server.
1. **Never invent a slug or arg.** Get them from `COMPOSIO_SEARCH_TOOLS` (returns
   `input_schema` inline for most tools). Only call `COMPOSIO_GET_TOOL_SCHEMAS`
   when a result carries `schemaRef` instead of `input_schema`.
2. **Let Composio resolve IDs for you.** Put stable hints in `known_fields`
   (`"<key>:<value>"`, e.g. a name or slug) so search resolves missing IDs —
   before you go introspect them by hand.
3. **Read model ≠ write model.** The name a field reads back as is often not the
   name you write to; labels are not identifiers. Single-selects and custom
   fields are frequently backed by a separate internal identifier or
   auto-generated type (opaque suffixes, generated key strings, backing-type
   names). Get the write name from the schema, not the query result.
4. **Resolve option/relation values by reading a live record**, not by assuming
   its label or id.
5. **Ask, don't guess, on human choices.** If the target entity/project/state
   doesn't uniquely resolve, or the user's word maps to 2+ candidates, use
   `ask_user` with the candidates as options. One ask beats three wrong writes.
6. **Flag shared-scope side effects first.** Renaming an enum option, deleting a
   type, retargeting a relation hits *every* record using it. Say so; if
   irreversible, confirm before doing it.
7. **If a response says a tool/toolkit is restricted, STOP** and tell the user.
   No workarounds.

## Loop (mutations against an unfamiliar schema)

```text
0. direct?     mcp() -> is there a dedicated server for this app? if yes:
               mcp(server:"<app>") -> use the native tool, done
1. search      COMPOSIO_SEARCH_TOOLS(queries:[{use_case, known_fields}], session:{generate_id:true})
2. schema      only if the result shows schemaRef (not input_schema)
3. resolve     read live records -> concrete ids/write-names
4. (ambiguous?) ask_user with options
5. mutate      CREATE / UPDATE with confirmed names + ids
6. verify      only if the response didn't echo the field, or it's a no-op-prone
               kind (rich text, attachment, computed)
```

For plain reads, or a tool whose schema you already fetched this session, skip
the loop and go direct.

## Session + multi-execute (exact shapes)

- **Session is asymmetric.** `SEARCH_TOOLS` takes nested `session:{generate_id:true}`
  (new) or `session:{id:"…"}` (continue) and returns the id. Every *other* meta
  tool takes flat `session_id:"…"`. Pass it on all of them.
- **`COMPOSIO_MULTI_EXECUTE_TOOL` shape** — verify against `mcp(describe:…)` if
  unsure:
  - `tools: [{tool_slug, arguments, account?}]` — ≤50, logically independent only
  - `thought`, `session_id`, `current_step` — **top-level**, not per-item
  - `sync_response_to_workbench` — **required** bool
- Batch independent writes in one call (e.g. set a field on 10 records at once).
- Response is structured for direct use — don't reprocess it through bash/
  workbench by default. Only when a response is spilled to a workbench file
  (path is in the response) use `COMPOSIO_REMOTE_BASH_TOOL` + `jq` to extract.
- Paginate when a response returns a page token and completeness is implied;
  don't report partial results as complete.

## Shape traps that generalize across apps

- **List roots may not be the entities.** A query root can return groups/columns
  (statuses, boards, channels) whose real records live one level down in a nested
  collection. Read one result fully before assuming its shape.
- **Some fields can't be written by the generic update tool.** Rich text, file
  attachments, computed fields often need a dedicated tool/endpoint or a token.
  On rejection or silent no-op: check for a purpose-built tool first (e.g. an
  append-document or add-comment tool), then tell the user and offer an
  alternative — don't retry blindly.
- **The internal name in an error is the source of truth, not the label.** On
  `type-not-found` / `field-not-found`, fetch the schema for the real name before
  retrying — don't re-guess.
- **Connection is per-toolkit.** `SEARCH_TOOLS` reports it. If inactive, initiate
  via `COMPOSIO_MANAGE_CONNECTIONS` (+ `COMPOSIO_WAIT_FOR_CONNECTIONS`); don't
  fire calls that will 401.
