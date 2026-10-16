---
name: task
description: Executes a multi-step change in small verified steps — resolves vague references, maps impact, runs one step at a time, and stops on blockers. Use when the user gives an order with several steps, a terse follow-up like "do it" or "fix that", or a change that touches several files, tests, or configs.
disable-model-invocation: true
---
# Task

## Before you start

1. **Resolve the request** from recent context. "Fix that" or "do it" refers to the last proposed plan or finding. If two readings remain and the wrong one is costly, ask.
2. **Map the impact**: affected files, tests, docs, configs, and consumers. Flag breaking changes.
3. **Check the state**: paths, versions, permissions, and a clean starting point.

## Execute

Order: back up (only before destructive changes) → code → config → validation.

Write each step as:

```
Step N: [action]
- Files: [exact paths]
- Command: [exact command]
- Expected: [what success looks like]
```

- Do one step, check its result, then start the next.
- For long plans, report after every batch of about 3 steps. Continue unless the user must decide something.

## Blocked

A missing dependency, a failing test, or an unclear instruction → stop. Do not guess or work around it. Report the command, the output, and the `file:line`, then ask.

## Finish

Apply the `verify` skill checks. Report each step, its evidence, and anything still open.
