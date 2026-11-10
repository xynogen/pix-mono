---
name: task
description: Carries a multi-step change through to a verified result using conversation context and proportionate planning. Use for multi-file work or short follow-ups such as "do it" or "fix that".
disable-model-invocation: true
---
# Task

## Approach

Use the whole conversation to resolve the goal and target. Inspect relevant code and any reference project before asking the user to fill gaps. Make routine implementation decisions yourself; ask only about unresolved choices that materially affect scope, cost, or safety.

## Execute

Plan only as much as the change needs. Group related edits and checks; do not narrate every tool call or wait for approval between routine steps. Preserve unrelated work and respect permission boundaries.

## Blocked

Diagnose failures and use available alternatives within the authorized scope. Stop for missing permission, a consequential user decision, or a blocker you cannot resolve safely. Report the specific cause and what is needed; do not retry blindly.

## Finish

Check the result against the user's goal with relevant tests and a diff review, following repo requirements. Report the outcome, evidence, and anything still unverified. Do not treat successful edits or tool calls as proof that the task is complete.
