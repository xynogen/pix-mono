---
name: clone
description: Temporarily clones an external git repository into /tmp/clones for read-only exploration and reports its stack and layout. Use only when the user's goal is to inspect or analyze a repository. Do not use for working copies, edits, or a destination the user named.
disable-model-invocation: true
---
# Clone for exploration

**Fit check:** use this only for temporary, read-only exploration. Do not use it when the user asks to clone "here", names a destination, needs a working copy, or plans to modify the repo. A git URL or the word "clone" alone is not enough.

## Steps

1. **URL** — Accept https, ssh, or `owner/repo`. Expand `owner/repo` to `https://github.com/owner/repo` only when the user gave no host.
2. **Target** — `/tmp/clones/<repo-name>` (repo name from the URL, without `.git`). Run `mkdir -p /tmp/clones` first.
3. **Clone or refresh**
   - Path is a git repo → `git -C <path> fetch --all --prune`. Do not re-clone.
   - Path exists but is not a git repo → stop and report.
   - Otherwise → `git clone --depth=1 <url> <path>`. Full history requested → no `--depth`, or `git -C <path> fetch --unshallow` on an existing clone.
   - Clone fails (auth, 404) → report the error and stop. Do not try other URLs.
4. **Orient** — Run only what the question needs. Default: `ls <path>`, the first 50 lines of `README.md`, the manifest (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, ...), and `git -C <path> log --oneline -5`.
5. **Report** — `Repo ready at /tmp/clones/<name> — <stack> — <N> entries at root.` Then answer the user's question.

## Rules

- Read-only. Never commit, push, or edit files in the clone unless the user asks.
- `/tmp` is cleared on reboot. Tell the user if they need a persistent copy.
