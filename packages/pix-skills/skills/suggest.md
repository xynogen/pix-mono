---
name: suggest
description: Multi-dimensional optimization and improvement recommendations. Use when user asks "how can I improve this", "what would you change", "any suggestions", "make this better", or wants prioritized options rather than a single fix.
disable-model-invocation: true
---
# Suggest

Goal: a ranked list of improvements. Each one is concrete enough to act on without more research.

## Steps

1. **Ground** — Read the target code first. Note its conventions, stack, and past design decisions. Every suggestion must fit them.
2. **Ideate** — Cover what applies: DX (readability, locality), UX (behavior, latency, errors), performance (hot paths, allocations, queries), maintainability (coupling, tests, dead code).
3. **Rank** — Impact ÷ effort, highest first. Drop any idea that adds a capability nobody uses (YAGNI). Prefer a local fix to a rewrite. Deletion ranks high.
4. **Report**

```
### 1. [Title] — Impact: High · Effort: Low
**Problem:** [what is wrong] — `file:line`
**Change:** [exact change; code if short]
**Why:** [benefit]
```

Every item needs a `file:line` and a concrete change. "Improve error handling" is not a suggestion.
