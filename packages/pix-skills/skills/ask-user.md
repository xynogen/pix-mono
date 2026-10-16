---
name: ask-user
description: Decision gate for high-stakes or irreversible choices and unclear requirements. Gathers evidence, then makes one focused ask_user call with 2-4 options per question. Use before changing architecture, schema, APIs, deploys, or security, or when a wrong guess is costly to undo.
disable-model-invocation: true
---
# ask_user decision gate

## Gate — ask before you act if any is true

- The step changes architecture, schema, API, deploy, or security.
- The step is costly to undo (large refactor, migration, destructive edit, production behavior).
- Requirements are unclear, conflict, or are missing.
- Several options are valid and the choice depends on preference.
- You are about to assume something that changes the implementation.

Skip the gate if the user already decided this exact trade-off.

## Steps

1. Gather evidence first (read, search, web). Never ask blind.
2. Write 3-7 bullets: current state, constraints, trade-offs, your recommendation.
3. Call `ask_user` once. Group related questions in that call (max 4).
   - Each question: 2-4 options, a `header` of 16 characters or fewer (count them: "DB path", not "Database Setup"), labels of 1-5 words, and a `description` with the trade-off.
   - Put risk-reducing preconditions into the options (e.g. "Back up, then migrate") so no option skips a safety step.
   - Put the recommended option first and add "(Recommended)" to its label.
   - Use `multiSelect` only for independent choices. Use `preview` to compare code or layouts side by side.
   - Single-select adds a free-text row by itself. Do not add an "Other" option.
4. Restate the decision, name the next step, and continue.

## Budget

- One call per decision. Make a second call only if the answer was unclear or cancelled, and make it narrower: proceed with the recommendation / choose another / stop.
- Still unclear after the second call: high-stakes → stop and report the block. Ambiguity only, and the user said "your call" → take the most reversible default and state your assumptions.
- Never re-ask the same trade-off without new evidence. No confirmation loops.

## Do not

- Ask without context, or ask about trivial formatting.
- Force options where a free answer fits better.
- Continue a high-stakes step after a cancelled or unclear answer.
