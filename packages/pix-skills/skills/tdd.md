---
name: tdd
description: Pragmatic test-driven development for any language or framework. Use when building features or fixing bugs test-first without dogma — red-green loop, seams, vertical slices, with sanctioned exceptions.
---
# Pragmatic TDD

Test-first by default, not test-first as religion. The loop is the tool; keeping momentum matters more than ritual purity.

## The Loop

1. **RED** — write one small failing test for the next behavior. Run it. It must fail because the behavior is missing (a typo or setup error doesn't count as red).
2. **GREEN** — write the simplest code that passes. No speculative features, no drive-by refactors.
3. **REFACTOR** — once green, clean names and duplication. Tests stay green. No new behavior.
4. Repeat, one vertical slice at a time: one test → one implementation → next test. Never write all tests up front.

## Where tests go: seams

Test at public boundaries — the interface a caller actually uses — never internals. A good test reads like a spec ("rejects empty email") and survives refactors because it doesn't know how the code works, only what it does.

- Don't test private helpers directly; test them through the public seam.
- Prefer real code over mocks. Mock only unowned boundaries (network, clock, filesystem when slow).
- Expected values come from an independent source (spec, worked example, known literal) — never recomputed the same way the code computes them.

## Sanctioned exceptions — no guilt, but say so

Test-after or no-test is fine for:

- **Spikes/exploration** — explore freely, then either throw it away and redo test-first, or backfill tests before merging. Backfilled tests must be broken on purpose once (mutate the code, watch them fail) to prove they bite.
- **Trivial glue** — one-line delegations, config, generated code, pure declarations.
- **UI layout/styling** — assert behavior if any, not pixels.
- **Hard-to-harness legacy code** — add a characterization test at the nearest seam you *can* reach, then proceed.

When you skip test-first, state it in one line ("skipping TDD: config-only change"). Silent skipping is the failure mode, not the skipping itself.

## Non-negotiables (the relaxed variant still keeps these)

- **Bug fixes always get a failing test first.** Reproducing the bug in a test is the fix's proof and the regression guard.
- **A test you never saw fail proves nothing.** Watch red at least once — fresh or via deliberate mutation.
- **Green means all green.** Other tests breaking is your problem now, not later.
- **Never weaken an assertion to get to green.** Fix the code or renegotiate the requirement, out loud.

## Smells to stop on

- Test needs heavy mocking → the design is too coupled; simplify the interface before writing more tests.
- Test setup is huge → extract helpers, or the seam is wrong.
- Test breaks when you refactor without behavior change → it's coupled to implementation; rewrite it against the seam.
- Assertion is `expect(f(a,b)).toBe(a+b)` style → tautological; use a literal.
