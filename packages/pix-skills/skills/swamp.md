---
name: swamp
description: Swamp-style workflows on codemode — turn a task that repeats (review, release check, report, data pull) into a saved script in .pi/workflows/<name>.js that code runs and the agent only judges. Build once, run with the codemode stub, patch only the failing step. Use when the user asks to save, run, list or fix a workflow, or when the same multi-step task comes up again.
disable-model-invocation: true
---

# Swamp workflows (codemode)

Idea from Swamp (swamp-club.com): the agent builds a workflow once, code runs it, the model only does the steps that need judgment. Here the engine is `codemode`; no CLI to install.

## When

- Make a workflow when a task repeats with the same steps. Keep one-off or exploratory work as normal tool calls.
- Before building, `ls .pi/workflows/` — reuse or patch an existing one.

## Layout

- `.pi/workflows/<name>.js` — async function body. Gets `tools` (same as codemode) and `args`. Returns the text the agent needs to judge, nothing more.
- `.pi/workflows/runs.jsonl` — one line per run: `{name, args, ok, error, ms, ts}`. Read it to answer "what happened last run".
- First two lines of each file: a comment with what it does and its `args` shape.
- `.pi/` is often gitignored. If the user wants workflows shared or reviewed, ask before un-ignoring or moving them.

## Build

1. Steps with no judgment (git, tests, lint, fetch, parse) are code. Run independent ones with `Promise.all`.
2. Validate `args` at the top and `throw` on bad input. Fail loudly; never pass a blank or guessed value on.
3. Never put shell-interpolated `args` in a command without an allowlist regex check.
4. Cap and trim output in the script (`tail`, `head -c`, pick fields). The return value is what costs tokens.
5. Run it once with the stub and check the result before telling the user it works.

Helper every workflow needs (`bash` output has a `--- Changes ---` footer and ANSI colors):

```js
const sh = async (command) => {
	const r = await tools.bash({ command });
	const out = r.output.split("\n--- Changes ---")[0].replace(/\x1b\[[0-9;]*m/g, "");
	return { ok: r.exit_code === 0, out: out.trim() };
};
```

## Run

Call `codemode` with this stub. Change only `name` and `args`:

```js
// @options: {"timeout_ms": 600000}
const name = "review", args = {};
const src = (await tools.bash({ command: `cat .pi/workflows/${name}.js` })).output;
const AF = Object.getPrototypeOf(async function () {}).constructor;
const t0 = Date.now();
let out, err;
try { out = await new AF("tools", "args", src)(tools, args); } catch (e) { err = String(e?.message ?? e); }
const log = JSON.stringify({ name, args, ok: !err, error: err, ms: Date.now() - t0, ts: new Date().toISOString() });
await tools.bash({ command: `printf '%s\\n' ${JSON.stringify(log)} >> .pi/workflows/runs.jsonl` });
if (err) throw new Error(`workflow ${name}: ${err}`);
return out;
```

- Load with `bash cat`, not `read`: `read` adds `LINE#HASH|` anchors that break the script.
- After the run, the agent does the judgment step (review, decide, summarize) on the returned text.

## Fix (patch the delta)

1. Read the error in the result, or the last lines of `runs.jsonl`.
2. `read` the workflow file and `edit` only the failing step. Never rewrite the whole file.
3. Run the stub again. One fix, one run.
4. If the fix changes `args` or output shape, update the header comment.

## Pitfalls

- LSP flags `.pi/workflows/*.js` (top-level `await`/`return`, unknown `tools`/`args`). Expected: the file is a function body. Ignore those diagnostics.
- The sandbox has no file system, network or timers. All I/O goes through `tools`.
- Tool calls are real. A workflow that edits, pushes or deletes still needs the user's approval for that action.
