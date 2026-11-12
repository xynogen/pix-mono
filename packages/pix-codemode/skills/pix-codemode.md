---
name: pix-codemode
description: How to write `codemode` scripts that work the first time — tool identifiers, Promise.allSettled batches, filtering large results, and store/load limits. Use before batching several tool calls, chaining dependent calls, or filtering large tool output.
disable-model-invocation: true
---
# codemode — scripted tool calls

The script runs in a QuickJS sandbox: top-level `await` and `return` work, with no Node, file system, network, or timers.

## Call tools by their identifier

- Call `await tools.<identifier>(args)`. A tool named `mcp__docs__search` is `tools.mcp__docs__search`.
- Only tools listed in the `codemode` description, or found with `await searchTools("query")`, exist under `tools`. `tool_search` itself is not a script tool: `tools.tool_search` failed 28 times in history.
- A tool that is not listed: `await describeTool(name)` shows its schema; `ALL_TOOLS` lists every callable name.
- Most tools resolve to a string. Tools whose declaration says so resolve to an object; `bash`, for example, returns `{ output, exit_code, ... }`.

## Batch independent calls

```js
const r = await Promise.allSettled([
  tools.read({ path: "a.ts", limit: 80 }),
  tools.grep({ pattern: "TODO", path: "src", limit: 20 }),
]);
return r.map((x) => (x.status === "fulfilled" ? x.value : `ERR ${x.reason}`)).join("\n=====\n");
```

- Use `allSettled`, not `all`, so one failure does not hide the other results.
- Report rejected calls and error fields. Do not return only "done".
- Do not bundle a change and its check in one script. Inspect each result before the next step.

## Keep output small

- Filter in the script before returning: `split("\n").filter(...)`, `slice(0, 40)`, or pick JSON fields.
- `store(key, value)` / `load(key)` hold small state between scripts, not tool output. Large values are rejected.

## Common script errors in history

| Error | Fix |
|---|---|
| `tools.tool_search does not exist` | Call `tool_search` directly, outside the script, or use `searchTools()`. |
| `SyntaxError: unexpected end of string` | Long strings with quotes or backticks: build them with template literals, or pass arrays. |
| `oldText matches more than once` | The inner `edit` call needs a unique match or hash anchors. |
| `Script aborted` | The user cancelled, or a call ran too long. Split the script. |

Shell parameter expansion (`${KEY%/}`) works only in `bash`. Pass `$KEY` plainly in other tools.
