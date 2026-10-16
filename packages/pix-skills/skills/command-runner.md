---
name: command-runner
description: Checks workspace health from live git status and diff before running automation, and asks before it stages anything. Use before a scripted or bulk operation that needs a known, clean working tree.
disable-model-invocation: true
---
# Command Runner

## State (live at load time)

!`git status -s`

!`git diff HEAD`

## Steps

1. Read the status and diff above.
2. Unstaged files exist → ask before you stage them.
3. Continue with automation only if the tree is clean or the user overrides.
