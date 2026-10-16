---
name: debug
description: Root-cause debugging — reproduce, find the broken invariant, test one hypothesis at a time, then fix at the source with a regression test. Use when something errors, crashes, hangs, returns wrong output, or a test fails for an unknown reason, and before proposing any fix.
disable-model-invocation: true
---
# Debug

**No fix without a root cause.** Until step 3 confirms a cause, propose no fix.

## Steps

1. **Collect** — Read the full error and stack trace: messages, `file:line`, codes. Reproduce the failure reliably. If you cannot, gather more data. Do not guess. Check recent changes: `git diff`, recent commits, new dependencies, config.
2. **Locate** — List what must be true for the code to work. Find the invariant that breaks. Trace the data backward from that point to the first wrong value. In a multi-part system, log at each boundary once, then read the output. Compare with similar code that works and list every difference.
3. **Hypothesize** — Write it down: "X is the cause because Y." Test it with the smallest change, one variable at a time. Wrong → form a new hypothesis. Never stack fixes.
4. **Fix** — Write a failing test that reproduces the bug. Make one targeted fix at the source, not the symptom. No unrelated changes. Run the full suite (see `test`).
5. **Record** — If a missing rule caused the bug, propose the rule for the repo instructions.

Reason from the mechanism ("this error means Y in state Z"), not from analogy ("last time this meant X").

## Escalate

Three failed fixes → stop. The design is likely wrong, not the hypothesis. Show the evidence to the user before you try again.

## Back to step 1 if you think

- "Quick fix now, investigate later."
- "Just try X and see."
- "It's probably X."
- "I don't fully understand, but this might work."
- Each fix shows a new problem somewhere else.
