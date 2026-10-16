---
name: diff
description: Reviews the current uncommitted git changes from live status, staged, and unstaged diffs — summarizes intent and flags bugs, security issues, and out-of-scope edits. Use when asked to "review my changes", "check the diff", or "what did I change" before a commit.
disable-model-invocation: true
---
# Diff Review

## State (live at load time)

!`git status -sb`

!`git diff --cached --stat`

!`git diff --cached`

!`git diff --stat`

!`git diff`

## Steps

1. Nothing staged and the tree is clean → say "nothing to review" and stop.
2. Summarize: each file touched and the intent of its change.
3. Flag bugs, logic errors, security issues, and missing error handling. Give `file:line` for each.
4. Flag changes that do not fit the apparent goal.
