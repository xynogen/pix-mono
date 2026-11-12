---
name: pix-subagent
description: How to delegate with `agent` and `agent_control` — a self-contained brief, live type discovery, background runs, steering, and fetching results. Use when a task splits into independent parts that a cheaper model can do, not for work that fits in this context.
disable-model-invocation: true
---
# agent — delegated child sessions

Two tools: `agent` spawns, `agent_control` inspects and steers. A background child holds the shared state at `working` while it runs.

## agent

```
prompt          string    self-contained brief
description     string    3-5 word UI label
type            string    from agent_control(action:'info', kind:'types')
model?          string    "provider/id" or fuzzy ("haiku"); omit to inherit
allowed_tools?  string[]  intersected with the type's allowlist, never widened
thinking?       enum      medium (default) or high
turns?          number    omit for unlimited
resume?         string    agent ID to continue
background?     bool      default true
remind?         bool      default false — wake the idle parent on completion
```

The child does not inherit the parent's context. The prompt must carry the objective, the output format, the tools or sources to use, and the scope limits: which files it may touch and what it must not change. A vague brief is the usual cause of a wasted agent.

`thinking` above `high` needs an explicit user decision with a benefit and cost justification. Keep `medium` or `high`.

## agent_control

`{ "action": "info" | "result" | "steer" | "stop", "agent_id": "...", ... }`

- `info` with `kind: "types" | "models" | "active"` — discover valid types, usable models, and running IDs. Use it before spawning, instead of guessing a type.
- `result` with `agent_id`, plus `verbose` for the full transcript or `turns` for the last N. Fetching a result consumes its completion notice.
- `steer` with `agent_id` and `message` — inject an instruction into the running child.
- `stop` with `agent_id`, `force` if it must end immediately.

## Do not

- Spawn parallel agents that edit the same files. Split by non-overlapping scope, or run them sequentially.
- Fan out a task that needs the parent's reasoning or a decision only the user can make.
- Lose the `agent_id`. If it is missing, `info kind:"active"` recovers the running IDs.
- Poll in a loop. `background` plus `remind`, or one `result` call, is enough.
