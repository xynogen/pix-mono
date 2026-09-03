# @xynogen/pix-subagent

Pi extension — planner-driven sub-agents with 2 tools, live widget (model always visible), and explicit work-splitting.

## Install

```bash
pi install npm:@xynogen/pix-subagent
```

> Also included in [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core):
>
> ```bash
> pi install npm:@xynogen/pix-core
> ```

## What it does

Gives the parent agent (planner) two tools to delegate and control child sessions:

| Tool | Purpose |
|---|---|
| `agent` | Spawn a sub-agent |
| `agent_control` | Discover types/models/active IDs, fetch output, steer, or stop |

### The pix twist

A running background agent also opens an **agent-state** activity lease (`beginAgentActivity` from [`@xynogen/pix-runtime`](https://www.npmjs.com/package/@xynogen/pix-runtime)), so the shared state reads `working` while any child is in flight. It does not fire attention notifications — only `blocked` states (an open `ask_user` / gate / sudo prompt) do that.

**Model name is always visible** — in the widget header and completion notification, regardless of whether the child uses the same model as the parent. Looks like:

```
● Agents
├─ ⠹ Explore [haiku]  scout auth flow  · ↻2 · 3 tool uses · 12.4k · 1.2s
│     ⎿  grep "middleware" src/
└─ ✓ Plan [sonnet]  design refactor  · ↻5 · 2.1s
```

## Tools

### `agent` — spawn a sub-agent

```
prompt           string    Self-contained task description
description      string    3-5 words, shown in widget
type             string    Agent type (discover with agent_control)
model?           string    "provider/id" or fuzzy ("haiku"); omit to inherit
allowed_tools?   string[]  Restrict child's tools (intersected, never widens)
thinking?        string    off|minimal|low|medium|high|xhigh (default: medium)
turns?           number    Omit for unlimited
resume?          string    Agent ID to continue
background?      boolean   Default true (non-blocking); false waits for an inline result
```

**Background is the default.** Omit `background` (or set it to `true`) to return immediately and receive the result automatically on completion. Set `background: false` only when the parent must block until the result is available inline. The initial task prompt is shown in the tool card, then hidden after the shared `collapse.delaySec` threshold; set `collapse.tools.agent` to `false` to keep it visible. Expanding an elapsed card restores the prompt without restarting the timer.

### Short delegation guidelines

- Prefer direct tools for known or small tasks; launch agents only when delegation
  provides clear value.
- Give every child a compact, self-contained prompt. Do not fork or inherit the
  parent conversation: avoid `inherit_context: true` and `prompt_mode: append`.
- Use `thinking: "medium"` by default and `thinking: "high"` for genuinely
  complex work.
- Never use a thinking level above `high` unless the user first approves it after
  receiving a concrete benefit and cost/latency justification.

These rules are also embedded in the `agent` tool description so callers see
them even when they do not load the separate subagent skill.

**`allowed_tools[]`** is the work-splitting hook. Pass `["read","grep","find"]` to scope an Explore agent to read-only ops. The list is intersected with the agent type's default set — it can only narrow, never widen.

**`model`** accepts `"provider/id"` or fuzzy strings like `"haiku"`, `"sonnet"`. The recurring tool description does not embed the live model catalog; use `agent_control({ action: "info", kind: "models" })` to inspect it on demand. An unknown explicit model also returns currently available models. Omit `model` to inherit parent model.

### `agent_control` — inspect and control agents

```text
action      "info" | "result" | "steer" | "stop"
kind?       "types" | "models" | "active"   For info; defaults to active
agent_id?   string                            For result/steer/stop
message?    string                            For steer
query?      string                            For info filtering
limit?      number                            For info; default 20
verbose?    boolean                           Full result conversation
turns?      number                            Last N result turns
```

Examples:

```ts
agent_control({ action: "info", kind: "active" })
agent_control({ action: "steer", agent_id: "abc123", message: "Focus on runtime" })
agent_control({ action: "result", agent_id: "abc123", turns: 3 })
agent_control({ action: "stop", agent_id: "abc123" })
```

Active discovery returns running/queued IDs, preventing lost IDs from blocking steering. `info/types` reads live built-in and custom-agent registry. `info/models` combines authenticated runtime registry with pix-data metadata. Calling `result` suppresses completion notification because result was consumed.

Terminal foreground rows and background notifications remain one line by default. Control results use compact rows such as `✓ agent_control info types · 5 available`, `✓ agent_control result abc123 · completed`, and `✓ agent_control steer abc123 · delivered`; expansion shows exact returned text.

## Default agent types

| Type | Tools |
|---|---|
| `general` | all (read/bash/edit/write/grep/find/ls) |
| `Explore` | read/bash/grep/find/ls (read-only) |
| `Plan` | read/bash/grep/find/ls (read-only) |
| `Mentor` | read/bash/grep/find/ls (read-only) — senior advisor for critical decisions; caller must pick a model at least as capable as the parent |

Built-in types set the **tool allowlist and persona only** — never a model. The
caller picks the model per call via the `model` parameter on the `agent` tool,
or omits it to inherit the parent's. For mechanical/read-only work pass a cheap
tier; for hard reasoning match or exceed the parent. A read-only `Explore`
worker is not automatically cheap — you make it cheap by passing a cheap-tier
model. See `model` in the `agent` tool above.

## Custom agents

Drop a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global):

```markdown
---
description: Scout for auth-related code patterns
tools: read, grep, find
model: anthropic/claude-haiku-4-5
thinking: low
max_turns: 20
---
You are a read-only code scout. Find patterns, never write files.
```

Frontmatter fields: `description`, `tools` (CSV), `model` (caller-overridable default), `thinking`, `max_turns`, `extensions` (true/false/CSV), `skills` (true/false/CSV), `isolated`, `inherit_context`, `prompt_mode` (replace/append), `enabled` (false to disable).

**`model`** in a custom agent is a *caller-overridable default*: it applies
when the caller's `model:` param is omitted, but a caller's explicit `model:`
always wins. This is the pix principle — model selection is caller-decided,
always; the type/persona config never overrides it.

## Deferred (v2+)

- Git worktree isolation (`isolation: "worktree"`)
- Cron/interval scheduling (`schedule` param)
- Cross-extension RPC event bus
- `/agents` conversation viewer overlay
- Persistent agent memory (user/project/local scope)
- Smart group-join notifications for parallel fan-outs
- Chain/parallel orchestration modes

## Attribution

Spawn engine ported from [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) (MIT).
Work-splitting design inspired by [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) (MIT).
