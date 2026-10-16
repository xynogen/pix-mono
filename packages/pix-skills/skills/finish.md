---
name: finish
description: Closes out a finished feature branch — runs the full test suite, offers merge, pull request, keep, or discard, and executes the choice safely. Use when implementation is done and the user asks to wrap up, merge, open a PR, or clean up the branch.
disable-model-invocation: true
---
# Finish

## 1. Verify

Run the project's full test suite with the repo's own command. If it fails, show the failures and stop. Offer no options while tests are red.

## 2. Ask

Call `ask_user` with exactly these four options:

1. **Merge locally** into `<base-branch>`
2. **Push and open a PR**
3. **Keep the branch** as it is
4. **Discard** the branch and its commits

## 3. Execute

**Merge locally**

```bash
git checkout <base-branch> && git pull
git merge <feature-branch>
# Re-run the full test suite on the merged result. Red → stop and report.
git branch -d <feature-branch>
```

**Push and open a PR**

```bash
git push -u origin <feature-branch>
gh pr create --title "<title>" --body "## Summary
- <what changed>

## Test plan
- [ ] <verification steps>"
```

**Keep** — Report: "Branch `<name>` kept. No changes made."

**Discard** — Show: "This permanently deletes branch `<name>` and all its commits. Type 'discard' to confirm." Continue only on that exact word.

```bash
git checkout <base-branch>
git branch -D <feature-branch>
```

## Never

- Offer options or merge while tests fail.
- Merge without a test run on the merged result.
- Delete work without the typed confirmation.
- Force-push without an explicit request.
