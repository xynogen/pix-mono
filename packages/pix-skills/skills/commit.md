---
name: commit
description: Split, write, and maintain Conventional-Commit-style commits. Use only on explicit request — "commit this", "make a commit", "split these changes", "amend/squash the history".
disable-model-invocation: true
---
# Conventional Commit Management Directive

## The Iron Law

```
INVOCATION IS PERMISSION. User invoked this skill → commit without asking again.
Still forbidden: secrets, binaries, unrelated changes, trailer metadata.
```

## Below are what agent MUST do

### Phase 1: Inspect

The blocks below are pre-populated with live repository state at skill-load
time via `\!`cmd`` directives — read them before composing the commit.

#### Branch + short status

!`git status -sb`

#### Staged changes (index vs HEAD)

!`git diff --cached`

#### Unstaged changes (working tree vs index)

!`git diff`

- **AUTO-RUN**: The status + diff above are already loaded — review them, then proceed straight to commit. Re-run `git status` / `git diff` only after staging or `.gitignore` edits. Do NOT pause for "may I commit?" confirmation — user already asked.
- **GITIGNORE**: Before staging, inspect untracked/generated files. Add obvious ignore candidates to `.gitignore` (build dirs, caches, logs, temp files, editor/OS junk, local env files). Re-run `git status`. Uncertain whether file should be ignored vs committed → ask user before changing `.gitignore` or staging it.
- **GROUP**: Cluster changes by path/module and by functionality. Each cluster → one self-contained commit.
- **GUARD**: Scan diff for secrets, binaries, debug logs, unrelated edits. Halt and report if found.

### Phase 2: Compose

Format: `<type>(<scope>): <subject>`

- **type**: `feat` · `fix` · `chore` · `refactor` (also `docs`, `test`, `perf` when apt).
- **scope**: module/area touched. Clear, lowercase.
- **subject**: imperative, concise, no trailing period.

```
feat(auth): add token refresh on 401
fix(parser): handle empty CUDA frame without panic
refactor(api): extract response builder from handler
```

### Phase 3: Split & Stage

- Stage per cluster: `git add <paths>` (or `-p` for partial hunks).
- One commit per logical change. Never mix `feat` + unrelated `fix` in one commit.

### Phase 4: Maintain (when asked)

- Squash/amend/reorder to keep history clean. Remove WIP commits.
- Never rewrite pushed history without explicit confirmation (irreversible for collaborators).

### Phase 5: Offer push

- After successful commit, ask whether to push now so interaction stays short.
- Do **not** push automatically. `git push` is irreversible/shared-state; require explicit confirmation for that exact push.
- If user says yes, push current branch and report result.

## Authorship Rule

- Commits authored solely by user's git config identity.
- Do NOT add `Co-Authored-By`, `Signed-off-by`, or any trailer metadata.

## Red Flags — STOP

- Asking "should I commit?" after skill invoked — invocation already answered that.
- Secrets, binaries, or `console.log`/`print` debug lines in diff.
- One commit bundling unrelated changes.
- Rewriting pushed history without confirmation.
