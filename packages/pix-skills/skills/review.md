---
name: review
description: Strict code review of a diff, branch, PR, or file — correctness, security, contracts, tests, conventions, scope, and YAGNI — with findings by severity and a Pass / Pass with suggestions / Fail verdict. Also covers how to act on review feedback. Use when asked to review code, check a PR, or respond to review comments.
disable-model-invocation: true
---
# Review

Review as a strict, skeptical reviewer. Assume the code is wrong until the evidence shows it is right. Cite the rule or fact behind each finding. No praise, no softening.

## Scope

Read the repo instructions first (AGENTS.md, CONTRIBUTING, linter config). They define the rules. Then read the full diff and enough surrounding code to judge each change.

## Check

- **Correctness** — logic, edge cases, error paths, ordering, concurrency.
- **Security** — secrets, injection, unsafe input, permissions.
- **Contracts** — imports, exports, links, and cross-module APIs still hold. Find every consumer of a changed API.
- **Tests** — new behavior has tests. No unexplained skips. Tests assert behavior, not internals.
- **Conventions** — this repo's naming, structure, and style.
- **Idempotency** — scripts and migrations are safe to run again.
- **Scope and YAGNI** — no unrelated edits. Flag unused code or features for removal.
- **Hygiene** — no debug logs, commented-out code, or stray TODOs.

## Report

```
### [Blocker|Major|Minor] [title] — `file:line` (real line numbers from the hunk header, not offsets inside the hunk)
**Problem:** [what is wrong, with evidence]
**Fix:** [concrete change]
```

Severity: **Blocker** = incorrect, unsafe, or untested new behavior. **Major** = will cause trouble (debug logs that leak data, dead code). **Minor** = style and polish.

End with one verdict:

- **Fail** — any blocker: logic error, missing tests for new behavior, security issue, broken contract.
- **Pass with suggestions** — correct, with Major or Minor items.
- **Pass** — no findings.

## Acting on feedback

- Restate each item in your own words. If any item is unclear, ask before you change anything.
- Check each suggestion against this codebase. If it is wrong, push back with evidence (code, tests). If it adds something nothing uses, grep first and propose removal instead.
- Fix in this order: blockers (crashes, security) → simple fixes → refactors. Test after each fix.
- Acknowledge with facts: "Fixed: [change] in `file:line`." Never "Great point!" or "You're absolutely right!".
