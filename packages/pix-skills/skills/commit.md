---
name: commit
description: Split, write, and maintain Conventional-Commit-style commits. Use only on explicit request — "commit this", "make a commit", "split these changes", "amend/squash the history".
disable-model-invocation: true
---
# Commit

Invocation is permission: commit without asking again. Never commit secrets, binaries, debug logs, unrelated edits, or trailer metadata.

## State (live at load time)

!`git status -sb`

!`git diff --cached`

!`git diff`

## Steps

1. **Inspect** — Read the state above. Re-run git only after staging or `.gitignore` edits.
   - Untracked/generated files: add clear ignore candidates (build dirs, caches, logs, temp, editor/OS junk, local env) to `.gitignore`. If unsure whether to ignore or commit, ask first.
   - Secret in an untracked or ignored file (e.g. `.env`) → never stage it, ignore it, commit the rest, and name the file and key name (never the value) in your final message so the user can rotate it if it was ever exposed.
   - Secret, binary, debug print, or unrelated edit in a tracked or staged diff → stop, commit nothing, and report it with `file:line`.
2. **Group** — One commit per logical change, clustered by module and function. Never mix `feat` with an unrelated `fix`. Stage with `git add <paths>` (`-p` for partial hunks).
3. **Compose** — `<type>(<scope>): <subject>`
   - type: `feat` new capability · `fix` bug fix · `refactor` no behavior change · `perf` speed/memory · `docs` documentation · `test` tests only · `build` build system/deps · `ci` CI/CD config · `style` formatting only · `chore` tooling/misc · `revert` undo a commit.
   - Breaking change: add `!` after the scope, e.g. `feat(api)!: drop v1 routes`.
   - scope: lowercase module/area. Subject: imperative, no trailing period.
   - Example: `fix(parser): handle empty frame without panic`
4. **Commit with hooks on** — Let hooks run lint, format, typecheck, and tests. Do not repeat them by hand. If hooks miss required checks, follow repo instructions.
   - Hook fails → stop, report, fix in-scope issues, re-stage, retry. Never use `--no-verify` or disable hooks.
   - New hook setup: use `git rev-parse --git-path hooks`. No tracked hook folder, no `core.hooksPath`. Never overwrite existing hooks. Keep a repo's custom setup; migrate only on request.
5. **Maintain** (only when asked) — Squash, amend, or reorder; drop WIP commits. Never rewrite pushed history without explicit confirmation.
6. **Push** — After success, ask whether to push. Never push unprompted. Push the current branch only on a "yes", then report the result.

Author is the user's git identity only. No `Co-Authored-By` or `Signed-off-by`.
