---
name: agents
description: Creates, audits, or prunes a repository context file (AGENTS.md / CLAUDE.md) so it holds only non-inferable, verified instructions — no repo overview. Use when asked to write, init, review, trim, or update AGENTS.md, CLAUDE.md, or agent instructions for a repo.
disable-model-invocation: true
---
# AGENTS.md

The host loads this file into every turn. Each line costs tokens on every task, so it must earn its place.

Evidence (ETH Zurich, arXiv 2602.11988; arXiv 2601.20404):
- LLM-generated context files cut task success by ~3% and raise cost by >20%.
- Repository overviews do not help. Agents find structure themselves.
- Agents follow instructions closely. A specific, non-obvious rule pays off. A stale or wrong rule does harm.

Rule: **write only what an agent cannot infer from the code in a few tool calls.**

## 1. What belongs

| Keep | Example |
|---|---|
| Non-standard commands | `bun run test` (not `bun test`): needs `--isolate` + preload |
| Hidden constraints | "Never import across packages by path; use `exports`" |
| Traps the agent hit before | "Tests fail without `PI_CODING_AGENT_DIR` sandbox" |
| Approval / safety gates | "Patch bumps only; minor/major need approval" |
| Project conventions a linter does not enforce | commit scope = package name |
| Pointers to deep docs, loaded on demand | "Before adding a package, read `docs/architecture.md`" |

| Drop | Why |
|---|---|
| Directory tree, file list, "this repo contains…" | Inferable via `ls`/graph; measured as unhelpful |
| Tech stack restated from `package.json` / lockfiles | Inferable |
| Rules the linter, formatter, or typecheck already enforce | The tool tells the agent |
| Generic advice ("write clean code", "add tests") | No information |
| Anything you did not verify | Wrong rules are followed faithfully |

## 2. Steps

1. **Read the current file** if present. Treat it as input, not truth.
2. **Mine the non-inferable facts** — do not summarize the repo:
   - Task runner, CI config, and pre-commit hooks: find commands that differ from the ecosystem default.
   - Linter/tsconfig/guard tests: note what is already enforced, so you can drop it.
   - `CONTRIBUTING.md`, `docs/`, and the git log (`git log --oneline -50`): find conventions and repeated fix-ups that show traps.
   - Ask the user once (`ask_user`) for gates and traps you cannot see in the code.
3. **Verify every command** by running it or checking `--help`. Verify every path with `ls`. Delete a claim that you cannot verify.
4. **Prune** an existing file against §1. Every line must pass this test: "Would a capable agent get this wrong without it?" If not, cut it.
5. **Draft** in the shape below. Aim for under ~150 lines. Move long detail to a linked doc that the agent reads only when the task needs it.
6. **Show the diff** and get confirmation before you overwrite a non-trivial file.

## 3. Shape

```md
# <Project> — Agent Guide

## Commands
<only commands that differ from the ecosystem default, each with a one-line why>

## Rules
<hard constraints and gates, imperative, one line each>

## Traps
<known failure modes and the fix>

## Read before
<task → doc path, for detail that is loaded on demand>
```

- Imperative, one rule per line, no rationale paragraphs. A short "why" is fine when it stops a wrong workaround.
- If both files exist, keep one source. Make `CLAUDE.md` a one-line pointer (`See AGENTS.md`) or a symlink, so the files cannot drift.
- In a monorepo, put package-specific rules in a nested `AGENTS.md`. Do not grow the root file.

## 4. Report

```
## AGENTS.md: [created | pruned | updated]
Lines: [before] → [after]
Kept: [n] rules · Dropped: [n] (overview/inferable/unverified)
Unverified (removed): [list or none]
```
