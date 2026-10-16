---
name: verify
description: Proves a change works before it is called done — full test suite, reproduction of the original issue, regression and diff check, and an evidence-based report. Use before claiming a fix or feature is complete, before a commit or PR, or when the user asks "is it done?" or "does it work?".
disable-model-invocation: true
---
# Verify

**Evidence, not belief.** "It should work" is not verification.

## Steps

1. **Run the full suite** with the repo's own command, not only the new test. All pass, no new failures, no unexplained skips.
2. **Reproduce the original case.** Bug fix → run the original failing scenario and confirm it is gone. Feature → walk the user flow end to end.
3. **Check for regressions.** Run integration or smoke tests if they exist. Check the code next to the change. Read the diff for changes you did not intend.
4. **Check the output.** No new warnings or errors. No debug logs or commented-out code. Docs updated if a public interface changed.
5. **Report** what you verified, how (commands and results), and what is still uncertain. Never hide uncertainty.

## Not done if

- Tests pass, but you did not reproduce the original case.
- You only ran the new test.
- New warnings appeared.
- You did not run the code at all.
