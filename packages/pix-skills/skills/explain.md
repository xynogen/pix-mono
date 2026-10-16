---
name: explain
description: Technical deconstruction and logic tracing. Use when user asks "how does X work", "explain this", "walk me through", "what does this do", or needs to understand existing code/architecture before changing it.
disable-model-invocation: true
---
# Explain

Goal: the reader understands the code from your answer alone. They do not need to trace the codebase again.

## Steps

1. **Locate** — Run the needed searches and reads without asking. Find the exact target (file, function, class, or concept). Quote its `file:line`.
2. **Read** — Read the full target and its direct callers and callees. Never explain from a name alone.
3. **Deconstruct**
   - Name the parts: inputs → transform → outputs → side effects.
   - Trace the data: where it enters, what changes it, where it leaves.
   - Give the reason for each non-obvious choice. If the reason is unknown, say so. Do not invent one.
   - List the types, invariants, and assumptions the code needs.
4. **Report** in this form:

```
## What it does
[One sentence.]

## How it works
1. [Step] — `file:line`

## Data flow
[input] → [transform] → [output/side-effect]

## Why this way
[Reason, or "reason not documented".]

## Gotchas
[Edge cases, hidden dependencies, surprising behavior.]
```

## Writing style (STE100-inspired)

- One idea per sentence. Keep sentences short (about 20 words or fewer).
- Use active voice and present tense: "The parser reads the token", not "The token is read by the parser".
- Use simple words: "use", not "utilize"; "start", not "initiate".
- Use one term for one thing. Do not switch between synonyms for the same function or variable.
- Keep articles ("the", "a"). Do not drop them to save space.
- Use imperative for instructions. Use numbered steps for sequences.
- Keep code identifiers, error strings, and numbers exact. Style never changes them.

## Stop if

- You explain a function from its name without reading its body.
- You state a reason that no code or comment supports.
- You describe what a self-evident line does. Explain why instead.
