---
name: long-task
description: Runs work that spans many sessions through files in the repo — an init script, a JSON feature list, a progress log, and one commit per feature — so each new session gets its bearings from git and the files, not from memory. Use when the user starts a large build that will not fit in one session, or resumes one that already has `features.json` and `PROGRESS.md`.
disable-model-invocation: true
---
# Long task

Compaction alone does not carry a long build across sessions. Keep the state in files that the next session reads first (Anthropic, *Effective harnesses for long-running agents*).

## First session: set up

1. Agree the goal and the scope with the user. Write it at the top of `PROGRESS.md`.
2. Write `init.sh`: the commands that install, build, start, and test the project from a clean checkout. Run it once. Fix it until it passes.
3. Write `features.json`. Use JSON, not Markdown: models rewrite prose lists, but they edit JSON fields with care.

```json
[
  {
    "id": "auth-login",
    "description": "User logs in with email and password",
    "steps": ["POST /login returns a session cookie", "a bad password returns 401"],
    "passes": false
  }
]
```

4. Commit: `chore: long-task scaffold`.

## Every session: get your bearings

Before you change code:

1. `pwd` and `git log --oneline -20`.
2. Read `PROGRESS.md` and `features.json`.
3. Run `init.sh`. If the build or a test that used to pass now fails, fix that first.
4. Pick **one** feature with `"passes": false`. Tell the user which one.

## Work one feature

1. Build only that feature. Do not start a second one.
2. Check it against its `steps`, the way a user would (run the app, call the endpoint, run the test).
3. Set `"passes": true` only after the check passes. Never delete or reword a feature to make it pass. Tell the user if a feature is wrong.
4. Add to `PROGRESS.md`: date, the feature, what changed, what failed and why, and the next feature.
5. Commit: `feat(<scope>): <feature id>`.

## End of session

Leave the tree clean and committed, `init.sh` passing, and `PROGRESS.md` naming the next step. If the session stops in the middle of a feature, write the exact stop point in `PROGRESS.md` and leave `"passes": false`.
