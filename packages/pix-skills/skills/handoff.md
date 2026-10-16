---
name: handoff
description: Toggles a session handoff through HANDOFF.md — writes one when none exists (giving mode), or reads and deletes it when it exists (receiving mode). Use when the user says "handoff", is ending a session and wants the next one to continue, or starts a session that should pick up previous work.
disable-model-invocation: true
---
# Handoff

## 1. Find the root

Use the path the user named. Else run `git rev-parse --show-toplevel`. If still unclear, ask which directory to use. Refer to it as the root; do not set a shell variable.

## 2. Detect the mode

`HANDOFF.md` exists in the root → **receive**. It does not exist → **give**.

## Give

1. Collect from this conversation and the codebase: the goal, the current state, files in flight, what changed, every failed attempt with its reason, and the single next action. Summarize long parts, but never drop a decision or a failure.
2. Write `<root>/HANDOFF.md`:

```markdown
# Handoff — [work area]
**Date:** YYYY-MM-DD

## Goal
[What is being built and why, one short paragraph]

## Current State
[What works, what does not]

## Files in Flight
- `path` — [why it matters]

## Changed
- `path` — [what changed this session]

## Failed Attempts
- [What was tried] — [why it failed, with the error]

## Next Step
[The one concrete first action]
```

   Get the date from `date +%F`; never guess it. Always include **Failed Attempts**. If there were none, write `(none this session)`. This section is the most important one.

3. Report: `Handoff written → <root>/HANDOFF.md. Next session: load the handoff skill to resume.`

## Receive

1. Read `<root>/HANDOFF.md` in full.
2. Take in the goal and state. Never retry anything under **Failed Attempts**. Start code exploration from **Files in Flight**.
3. Delete the file (`rm <root>/HANDOFF.md`) so the next run starts in give mode.
4. Report: `Handoff received. Resuming from: [Next Step]. Skipping: [failed attempts].`
5. Do the Next Step. Do not ask the user to repeat context that is in the file.
