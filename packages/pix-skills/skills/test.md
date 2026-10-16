---
name: test
description: Finds, runs, and analyzes a project's tests, then fixes failures at the root cause. Use when asked to run tests, check coverage, explain a failing test, or fix a red suite. To write new code test-first, load the tdd skill instead.
disable-model-invocation: true
---
# Test

## Steps

1. **Discover** — Find the test command in the repo instructions, task runner, or manifest (`package.json` scripts, `Makefile`, `justfile`, `pyproject.toml`, `Cargo.toml`, `go.mod`). Use the repo's command, not a guessed one. Keep its required flags (isolation, preload, env vars).
2. **Run** — Start narrow (the affected file or test name) for fast feedback. Finish with the full suite.
3. **Analyze** — For each failure, record the test name, `file:line`, expected vs actual, and whether it is new or pre-existing.
4. **Fix** — Fix the root cause in the code or in the test, whichever is wrong. If the cause is unclear, load the `debug` skill.
5. **Report** — The command, pass/fail/skip counts, each fixed failure with its cause, and each failure left open.

## Rules

- Green means the full suite, not only the tests you touched.
- Never weaken an assertion, add a skip, or raise a timeout only to get green.
- A flaky test is a failure. Report it. Do not re-run until it passes.
- A new regression test must fail once before the fix (see `tdd`).
