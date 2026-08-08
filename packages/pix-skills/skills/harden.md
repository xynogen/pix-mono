---
name: harden
description: Retrofit static analysis onto an existing project in any language — lint, format, type/compile check, tests, dependency hygiene, audit, CI gate. Use only on explicit request — "harden this project", "add static analysis", "set up quality gates".
disable-model-invocation: true
---
# Project Hardening Directive

## Goal

An existing project gains a fail-fast static-analysis gate: one command locally, same command in CI, red blocks merge. Do not scaffold new projects — that is `bootstrap`'s job.

## Phase 1: Audit (read-only)

Inventory before touching anything:

- **Ecosystem** — detect language(s), build system, package/dependency manager, existing configs (linter, formatter, compiler/type-checker settings, CI files, hooks). Mixed-language repos: audit each language separately.
- **Existing tools win** — a project with a working linter keeps it; never swap tools for taste. Only fill gaps.
- **Verify, don't recall** — before proposing any tool, confirm it exists and its flags via `--help` or official docs. Ecosystems move; memory rots.
- **Gaps checklist** (rank by value/effort, report before applying):
  1. Formatter + linter present and enforced (not just installed)?
  2. Warnings fail CI, or are they decorative?
  3. Strictest static check the language offers covers ALL source including tests — type-check for typed languages, compiler warnings-as-errors, or a type-annotation checker for dynamic ones (mypy/pyright, sorbet, phpstan)?
  4. Test runner wired with at least one real test? Coverage threshold?
  5. Dependency vulnerability audit at high severity (`npm audit`, `cargo audit`, `pip-audit`, `govulncheck`, `mvn dependency-check`, `bundler-audit` — whatever the ecosystem ships)?
  6. Dependency versions locked (lockfile, pinned requirements, go.sum, Cargo.lock) + CI installs exactly those versions (frozen/locked/ci mode)?
  7. CI exists, runs the same commands as local, pinned toolchain version (never `latest`)?
  8. Dead-code / unused-dep detection — only for multi-package repos; use the ecosystem's tool if one exists, skip otherwise.

## Phase 2: Propose

Present the gap list with one-line fixes and effort estimates. Get approval before installing anything. Skip items the user rejects — no silent extras.

## Phase 3: Apply

- **One tool per job.** Prefer the ecosystem's converged default (examples: Biome or ESLint+Prettier; ruff+mypy; gofmt+vet+staticcheck; clippy+rustfmt; ktlint+detekt; php-cs-fixer+phpstan). Unsure what the current default is → check docs, don't guess.
- **Single gate command** — one entry point chaining format-check → lint → static/type check → tests, fail-fast. Use whatever the project already uses to run tasks: package-manager script, Makefile, justfile, rakefile, cargo alias, gradle task. CI calls this exact entry point, never a diverging copy.
- **Warnings are errors in CI.** A rule worth having is worth failing on.
- **Coverage: ratchet, don't aspire.** Set threshold to the current actual percentage; raise it later. Never set an aspirational number that fails on day one.
- **Pin versions** — tool versions locked by the dependency manager (or a pinned tool-version file: `.tool-versions`, `rust-toolchain.toml`, `.python-version`), toolchain version pinned in CI config.
- Config over code: use the tool's recommended preset + minimal overrides. No 300-line rule files.

## Phase 4: Verify + Report

- Run the full gate once — must pass green on the untouched codebase (fix or downgrade rules until it does; a gate that starts red gets deleted by the next dev).
- Break one thing on purpose (introduce a lint error), confirm the gate catches it, revert.

```text
## Hardened: [project name]

**Gate:** `[command]` → PASS
**Added:** [tool: purpose, one line each]
**Skipped:** [item: reason]
**CI:** [file, trigger, runtime pin]
**Ratchets:** coverage at N% — raise when it grows
```

Mixed-language repo: repeat the gate per language, one top-level command runs all.

## Red Flags — STOP

- Replacing a working tool the project already uses.
- Installing anything before Phase 2 approval.
- A gate that is red on the first run after setup.
- CI commands that differ from the local gate script.
- Aspirational coverage thresholds.
- Adding hooks (husky etc.) when a gate script + CI already covers it — hooks are opt-in, ask first.
