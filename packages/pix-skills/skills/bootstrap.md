---
name: bootstrap
description: Scaffolds a new, runnable project skeleton from the stack's official docs — init command, standard layout, pinned dependencies, .env.example, and a passing baseline build or test. Use only on explicit request such as "scaffold a project", "bootstrap this", "init a new service", or "set up a new X app".
disable-model-invocation: true
---
# Bootstrap

Goal: a skeleton that a new developer can clone and run in minutes.

## Steps

1. **Confirm the stack** — If the language, framework, or package manager is unclear, ask once (`ask_user`). Confirm the target directory is new or empty. Never scaffold over existing files.
2. **Check the docs** — Read the official setup docs (web fetch or a docs tool). Check every flag with `--help`. Never invent init flags.
3. **Init** — Run the standard init (`bun init`, `npm init -y`, `cargo init`, `go mod init`, `uv init`, ...). Use the ecosystem's standard layout.
4. **Dependencies** — Install only what the user named or the stack needs. Pin versions. Ask before the first network install.
5. **Env** — Write `.env.example` with placeholders for every required variable. Never write real secrets or a real `.env`.
6. **Extras** — Add a linter, formatter, or CI only if the user asked. Otherwise offer them in the report.
7. **Baseline** — Run the build or test command once and confirm it passes. If the fresh skeleton has no test command, say so; do not invent one. If the baseline fails twice, stop and report.

## Report

```
## Scaffolded: [name]
Stack: [language / framework / package manager]
Layout: [top-level tree]
Run it:
  1. [command]
  2. [command]
Env vars: see `.env.example`
Baseline: `[command]` → PASS
Optional next: [linter / formatter / CI, if not added]
```
