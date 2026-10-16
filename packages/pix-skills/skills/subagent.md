---
name: subagent
description: Plans a task, splits it into independent units, and fans them out in parallel to cheaper subagent models with the agent tool, then integrates and verifies the result. Use when a task splits into 2+ parts that do not depend on each other and a strong model is more than each part needs.
disable-model-invocation: true
---
# Subagent fan-out

The scarce resource is the orchestrator's context and attention, not raw speed. Send mechanical units to cheap workers in parallel. Keep the plan, the seams, and the final check on the strong model. Workers do not plan, split further, or spawn their own agents.

## Use only when all hold

- The task has 2+ units, and no unit needs another unit's output.
- Each unit is mechanical given a precise spec (repetitive edits, boilerplate, test scaffolds, format conversion, per-module refactors, read-only surveys).
- You can fix the shared decisions (contracts, names, paths) before the split.

Do not use when units write the same file or region, the work is hard reasoning end to end, or the units form a chain (B needs A's output). For a chain, run it yourself or in one agent.

## Tools

- `agent_control({ action: "info", kind: "models" })` — list models with score, context, and price. `kind: "types"` lists agent types.
- `agent({ type, model, prompt, description, thinking, allowed_tools?, turns?, background? })` — start one worker. `background` defaults to `true`.
- `agent_control({ action: "result" | "steer" | "stop", agent_id })` — collect, redirect, or stop a worker.

Type and model are separate. `type` sets tools and persona (`Explore` read-only search, `Plan` read-only design, `general` full tools). It never picks the model. Set `model` on every call.

## Steps

1. **Plan** — Fix the exact paths, shared contracts (types, signatures), names, and acceptance checks. For a large task, get a plan first from `agent({ type: "Plan", thinking: "high", ... })`.
2. **Split** — Each unit must pass three tests: no dependency on another unit, no shared write target, and a self-contained spec. A unit that fails goes back to the orchestrator.
3. **Pick the model at call time** — Use the model the user named. Else pick a clearly cheaper model from `info` (lower price, adequate score). If none is clearly cheaper, ask. Never hardcode a model name. Omit `model` only to inherit the parent on purpose.
4. **Fan out in one turn** — Launch every unit in the same turn: N `agent` calls with `background: true`, or one `codemode` script with `Promise.allSettled`. One-by-one launches that wait for each result are serial: you lose the speed and the quality, and keep the context cost.
5. **Supervise** — Results arrive on completion. Do not poll or sleep-wait. If a worker runs much longer than its size suggests or goes off track, inspect it once and `steer` with a concrete fix (missing fact, right path, narrower goal). If that fails, `stop` it and relaunch with a better prompt.
6. **Integrate** — Read the real diff of every worker that wrote files. A worker's "done" is a claim, not evidence. Fix contract drift and seams yourself. Fix small misses inline instead of a re-spawn.
7. **Verify** — Run the repo's full gate (lint → typecheck → tests) on the combined result. Green units do not prove a green whole.

## Worker prompt contract

A cheaper model needs a tighter spec, not a looser one. The worker sees none of your conversation. Every prompt carries:

- **Goal** — the one artifact this unit produces.
- **Contract** — the exact types, signatures, and paths, copied in.
- **Constraints** — "edit only `<paths>`"; what not to touch.
- **Validation** — the local command to run and the expected result.
- **Output** — the exact shape of the reply (for example, a file list plus the command output).

Example for one unit of a 6-handler change:

```
agent({
  type: "general", model: "<cheap-model>", thinking: "medium", description: "add field to users handler",
  prompt: "Goal: add optional field `tenantId: string` to the request schema in src/handlers/users.ts.\nContract: validate with `isTenantId()` from src/lib/ids.ts; on failure return 400 { error: \"invalid tenantId\" }.\nConstraints: edit only src/handlers/users.ts. Do not change other handlers or shared helpers.\nValidation: run `bun test src/handlers/users.test.ts`; it must pass.\nOutput: the changed file path, a 2-line summary, and the test output tail."
})
```

## Limits

- `thinking`: `medium` by default, `high` for complex analysis. Above `high` needs the user's approval after you state the benefit and the cost or latency.
- Never fork context. No `inherit_context: true`, no `prompt_mode: append`, and no custom agent with either set. Copy only the facts the worker needs.
- One writer per file. Parallel writers touch disjoint files only.
- If you re-spawn the same unit more than once, it is too hard for the cheap model. Take it back.
