---
name: harden
description: Retrofits a fail-fast static-analysis gate onto an existing project in any language — format check, lint, type or compile check, tests, dependency audit, locked versions, and the same gate in CI. Use only on explicit request such as "harden this project", "add static analysis", or "set up quality gates". For new projects, load bootstrap instead.
disable-model-invocation: true
---
# Harden

Goal: one gate command that runs locally and in CI, fails fast, and blocks merge when red.

## 1. Audit (read-only)

Inventory before touching anything:

- **Ecosystem** — detect language(s), build system, package/dependency manager, existing configs (linter, formatter, compiler/type-checker settings, CI files, hooks). Mixed-language repos: audit each language separately.
- **Existing tools win** — a project with a working linter keeps it; never swap tools for taste. Only fill gaps.
- **Verify, don't recall** — confirm each tool and flag with `--help` or the official docs before you propose it.
- **Gaps checklist** (rank by value/effort, report before applying):
  1. Formatter + linter present and enforced (not just installed)?
  2. Warnings fail CI, or are they decorative?
  3. Strictest static check the language offers covers ALL source including tests — type-check for typed languages, compiler warnings-as-errors, or a type-annotation checker for dynamic ones (mypy/pyright, sorbet, phpstan)?
  4. Test runner wired with at least one real test? Coverage threshold?
  5. Dependency vulnerability audit at high severity (`npm audit`, `cargo audit`, `pip-audit`, `govulncheck`, `mvn dependency-check`, `bundler-audit` — whatever the ecosystem ships)?
  6. Dependency versions locked (lockfile, pinned requirements, go.sum, Cargo.lock) + CI installs exactly those versions (frozen/locked/ci mode)?
  7. CI exists, runs the same commands as local, pinned toolchain version (never `latest`)?
  8. Dead-code / unused-dep detection — only for multi-package repos; use the ecosystem's tool if one exists, skip otherwise.

## 2. Propose

Show the gaps as a table: item · status · fix · effort. Get approval before you install anything. Skip what the user rejects. No silent extras.

## 3. Apply

- **One tool per job.** Prefer the ecosystem's common default (Biome or ESLint+Prettier; ruff+mypy; gofmt+vet+staticcheck; clippy+rustfmt; ktlint+detekt; php-cs-fixer+phpstan).
- **Single gate command** — one entry point: format **check** (never write mode) → lint → static/type check → tests, fail-fast. Use whatever the project already uses to run tasks: package-manager script, Makefile, justfile, rakefile, cargo alias, gradle task. CI calls this exact entry point, never a diverging copy.
- **Warnings are errors in CI.** A rule worth having is worth failing on.
- **Coverage: ratchet, don't aspire.** Set threshold to the current actual percentage; raise it later. Never set an aspirational number that fails on day one.
- **Pin versions** — tool versions locked by the dependency manager (or a pinned tool-version file: `.tool-versions`, `rust-toolchain.toml`, `.python-version`), toolchain version pinned in CI config.
- Config over code: use the tool's recommended preset + minimal overrides. No 300-line rule files.

## 4. Verify and report

- Run the full gate once. It must pass on the current code; a gate that starts red gets deleted. To get there, fix code or relax rules, but list every relaxed rule and why in the report, and get approval for it.
- Prove the gate bites: with a clean `git status`, add one lint error to a single file, confirm the gate fails, then `git checkout -- <file>`.

```text
## Hardened: [project name]

**Gate:** `[command]` → PASS
**Added:** [tool: purpose, one line each]
**Skipped:** [item: reason]
**CI:** [file, trigger, runtime pin]
**Ratchets:** coverage at N% — raise when it grows
```

Mixed-language repo: repeat the gate per language, one top-level command runs all.

## Never

- Replace a working tool the project already uses.
- Install anything before approval.
- Let CI run different commands than the local gate.
- Add Git hooks (husky etc.) without asking. They are opt-in.
