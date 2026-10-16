---
name: composio-mcp
description: Safe workflow for Composio MCP tools — prefer a direct MCP server, get slugs and schemas from search, read live records before writing, and ask instead of guessing IDs or field names. Use when calling any app through Composio (COMPOSIO_* tools), especially for writes.
disable-model-invocation: true
---

# Composio MCP: introspect before you mutate

Field names, types, and enum options differ per workspace. Read the shape before you write.

## Rules

0. **Prefer a direct server.** List configured MCP servers (the `mcp` tool with no
   arguments, or `tool_search`). If the app has its own server, use its native
   tool. One native call replaces the whole Composio chain. Composio is the
   fallback for apps with no direct server.
1. **Never invent a slug or arg.** Get them from `COMPOSIO_SEARCH_TOOLS` (returns
   `input_schema` inline for most tools). Only call `COMPOSIO_GET_TOOL_SCHEMAS`
   when a result carries `schemaRef` instead of `input_schema`.
2. **Resolve IDs in order:** first put stable hints in `known_fields`
   (`"<key>:<value>"`) so search resolves them; if that fails, read one live
   record. Never assume an ID or option value from its label.
3. **Read name ≠ write name.** Labels are not identifiers; custom fields and
   selects often have a separate internal name. Take the write name from the
   schema, not from a query result.
5. **Ask, don't guess, on human choices.** If the target entity/project/state
   doesn't uniquely resolve, or the user's word maps to 2+ candidates, use
   `ask_user` with the candidates as options. One ask beats three wrong writes.
6. **Confirm wide writes.** Before a delete, a batch write, or a change that hits
   every record (renaming an option, deleting a type), show the target count
   and confirm.
7. **Restricted tool or toolkit → stop** and tell the user. No workarounds.
8. **Connections need consent.** Ask before you start a new connection or OAuth flow.
9. **Report** at the end: what you wrote, the record IDs, and anything unverified.

## Loop (mutations against an unfamiliar schema)

```text
0. direct?     dedicated MCP server for this app? -> use its native tool, done
1. search      COMPOSIO_SEARCH_TOOLS(queries:[{use_case, known_fields}], session:{generate_id:true})
2. schema      only if the result shows schemaRef (not input_schema)
3. resolve     read live records -> concrete ids/write-names
4. (ambiguous?) ask_user with options
5. mutate      CREATE / UPDATE with confirmed names + ids (confirm wide writes)
6. verify      only if the response didn't echo the field, or it's a no-op-prone
               kind (rich text, attachment, computed)
```

For plain reads, or a tool whose schema you already fetched this session, skip
the loop and go direct.

## Session + multi-execute (exact shapes)

- **Session is asymmetric.** `SEARCH_TOOLS` takes nested `session:{generate_id:true}`
  (new) or `session:{id:"…"}` (continue) and returns the id. Every *other* meta
  tool takes flat `session_id:"…"`. Pass it on all of them.
- **`COMPOSIO_MULTI_EXECUTE_TOOL` shape** — check the tool schema if unsure:
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
- **Connection is per-toolkit.** `SEARCH_TOOLS` reports it. If inactive, ask the
  user, then start it with `COMPOSIO_MANAGE_CONNECTIONS` and show them the link.
  Don't fire calls that will 401.
