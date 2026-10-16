---
name: runner
description: Generates, converts, or updates a task runner file (justfile, Makefile, mise tasks, Taskfile.yml, package.json scripts, or run.sh) for any project. Use when asked to add a justfile or Makefile, set up dev/test/lint tasks, or convert one runner format to another.
disable-model-invocation: true
---
# Task Runner Generation Directive

- **DETECT**: Scan project root for language/framework indicators (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Makefile`, `justfile`, `setup.sh`, etc.). Identify primary language, package manager, test runner, linter, formatter.
- **SCAN EXISTING**: Runner file already exists (any format) → read it first as source of truth. Parse recipes/tasks, dependencies, groups, descriptions, parameters.
- **ASK FORMAT**: After DETECT and SCAN EXISTING, ask which format to use with one `ask_user` call. Offer the 4 formats that fit the stack best (`ask_user` allows 4 options). Put an existing runner first, marked "(Recommended)". The free-text row covers the rest. Formats:
  - **justfile** — requires `just`. Native deps, groups, params, comments.
  - **Makefile** — universal, pre-installed on all Unix. `.PHONY` targets, deps via prerequisites.
  - **mise (mise.toml)** — task runner built into mise. Inline or file-based tasks with deps.
  - **Taskfile.yml (go-task)** — YAML-based, cross-platform. Requires `task` binary.
  - **package.json (npm scripts)** — requires Node. Simple key:value, no native dep graph.
  - **run.sh (shell script)** — zero dependencies. Single bash script with subcommands.
- **RESEARCH**: Unfamiliar with detected stack → consult official docs for canonical dev/test/lint/format commands before writing recipes.
- **GENERATE**: Create runner file in project root adapted to detected stack and chosen format.
- **VALIDATE**: Run format's list command after creation to confirm all recipes parse correctly.

## Required Task Structure

Every generated runner MUST include these standalone tasks at minimum:

| Task      | Purpose                                |
|-----------|----------------------------------------|
| `install` | Create local environment, install deps |
| `dev`     | Run the development server             |

Additional consolidated tasks added based on what project contains (see Detection-to-Task Mapping below).

For dotfiles repos, task structure follows group/module pattern instead (sync, CLI, GUI, AI, System).

## Task Consolidation

### Principle

Group related operations into single parameterized task with `<action>` argument instead of separate flat tasks. Reduces surface area, makes runner discoverable.

### Consolidation Decision Rule

| Condition | Action |
|---|---|
| Single command, no variants | Standalone task (e.g., `dev`, `install`) |
| 2+ related commands, action maps directly to a CLI arg | Simple parameterized — pass action through to the underlying tool |
| 2+ related commands, each runs different logic | Complex parameterized — case/conditional dispatch per action |
| Multi-step setup with no variants | Standalone with multi-command/array syntax |

### Detection-to-Task Mapping

Scan project for these files/patterns. When detected, generate corresponding consolidated task:

| Detected files | Task | Actions | Type |
|---|---|---|---|
| `docker-compose.yml`, `Dockerfile` | `docker` | `build\|up\|down` | Simple (pass-through to `docker compose`) |
| DB config, migration dirs, ORM config | `db` | `migrate\|seed\|setup` | Complex (each action runs different commands) |
| Test runner present | `test` | `unit\|tidy` | Complex (each action runs a different tool) |
| Formatter present | `format` | `fix\|check` | Complex (`fix` rewrites, `check` dry-run for CI) |
| Linter present | `lint` | `check\|fix` | Complex (`check` reports issues, `fix` auto-corrects) |
| Deploy config (`fly.toml`, `render.yaml`, `vercel.json`, CI/CD) | `deploy` | `staging\|production` or format-appropriate | Complex |
| `proto/`, gRPC/OpenAPI specs | `gen` | `proto\|types\|client` | Complex |

Agent MUST check these indicators during DETECT step. Only generate consolidated tasks for capabilities that actually exist in project. Don't generate `docker` if no `Dockerfile`.

### Naming Rules

- Task names: lowercase, single word when possible (`dev`, `test`, `db`)
- Descriptions: include action options in parens — `"Test operations (unit|tidy)"`
- Arg name: always `<action>` for the primary positional argument
- Bash blocks in parameterized tasks: always start with `#!/usr/bin/env bash` and `set -euo pipefail`
- **`lint` and `format` are NOT part of `test`** — they are separate concerns:
  - `test` → correctness (pytest, cargo test, go test, etc.)
  - `format` → code style; `fix` rewrites in-place, `check` is dry-run for CI
  - `lint` → static analysis; `check` reports issues, `fix` auto-corrects

## Language Adaptation Table

Use as reference when generating recipes:

| Language   | install                                        | dev                              | format                    | lint                        | test                     | tidy                                         |
|------------|------------------------------------------------|----------------------------------|---------------------------|-----------------------------|--------------------------|----------------------------------------------|
| Python     | `python -m venv .venv && .venv/bin/pip install -r requirements.txt` | `.venv/bin/python -m <app>`   | `ruff format .`           | `ruff check .`              | `pytest`                 | `find . -type d -name __pycache__ -exec rm -rf {} + && rm -rf .pytest_cache dist build *.egg-info` |
| Node/TS    | `npm install`                                  | `npm run dev`                    | `npx prettier --write .`  | `npx eslint .`              | `npm test`               | `rm -rf node_modules dist .next .nuxt`       |
| Rust       | `cargo build`                                  | `cargo run`                      | `cargo fmt`               | `cargo clippy`              | `cargo test`             | `cargo clean`                                |
| Go         | `go mod download`                              | `go run .`                       | `gofmt -w .`              | `golangci-lint run`         | `go test ./...`          | `go clean -cache -testcache`                 |
| Ruby       | `bundle install`                               | `bundle exec rails server`       | `bundle exec rubocop -A`  | `bundle exec rubocop`       | `bundle exec rspec`      | `rm -rf tmp/cache vendor/bundle`             |
| PHP        | `composer install`                             | `php artisan serve`              | `./vendor/bin/pint`       | `./vendor/bin/phpstan`      | `./vendor/bin/phpunit`   | `rm -rf vendor/ .phpunit.cache`              |
| Java       | `./gradlew build` or `mvn install`             | `./gradlew bootRun` or `mvn spring-boot:run` | `./gradlew spotlessApply` | `./gradlew check`   | `./gradlew test` or `mvn test` | `./gradlew clean` or `mvn clean`       |
| Elixir     | `mix deps.get`                                 | `mix phx.server`                 | `mix format`              | `mix credo`                 | `mix test`               | `mix clean`                                  |
| Zig        | `zig build`                                    | `zig build run`                  | `zig fmt .`               | `zig fmt --check .`         | `zig build test`         | `rm -rf zig-out zig-cache`                   |

## Format-specific rules

Read only the file for the chosen format with `read_skills(name="runner", resource="references/<file>")`:

| Format | Reference |
|---|---|
| justfile | `references/justfile.md` |
| Makefile | `references/makefile.md` |
| mise (mise.toml) | `references/mise.md` |
| Taskfile.yml (go-task) | `references/taskfile.md` |
| package.json (npm scripts) | `references/npm-scripts.md` |
| run.sh (shell script) | `references/run-sh.md` |

## Conversion Rules

When converting between formats:

1. **Source of truth**: Read existing runner file first. Parse all tasks, actions, deps, groups, descriptions, parameters.
2. **Preserve ALL tasks** — standalone and consolidated. Don't drop tasks or flatten consolidated tasks into separate entries.
3. **Preserve consolidation** — source has `test unit|tidy` as single parameterized task → target must also express it as one entry point (using target format's parameterization mechanism). `format` and `lint` are always separate tasks — do not merge them into `test`.
4. **Preserve dependency order** — task A depends on B → express this in target format.
5. **Preserve groups/categories** — use target format's native grouping or comment headers.
6. **Preserve descriptions** — map comments to target format's description mechanism. Include action options in parens.
7. **Handle parameters** — translate `<action>` args using target format's native mechanism. Format lacks arg validation (e.g., package.json) → use colon namespacing, document the workaround.
8. **Handle sudo** — preserve `sudo` prefixes where present.
9. **Default task** — every format must have help/list command as default entry point.

## Customization Rules

- **Monorepo**: Multiple languages detected → ask user which is primary. Generate one runner for root or per-workspace.
- **Existing runner**: Runner file already exists in target format → present diff of proposed changes, ask confirmation before overwriting.
- **Framework override**: Framework has own conventions (e.g., Next.js `next dev`, Django `manage.py runserver`) → prefer framework-specific commands.
- **Missing tools**: Recipe requires tool not present → add install step or note as prerequisite comment.
- **pyproject.toml**: `[tool.uv]` or `uv.lock` detected → prefer `uv`. `[tool.poetry]` → prefer `poetry`.
- **Extra tasks**: Agent MAY add additional consolidated tasks if project clearly benefits — but only when backed by detected project files (see Detection-to-Task Mapping). Don't speculatively generate tasks for capabilities project doesn't have.

## Report

After generation, output result of format's list command and confirm all recipes functional.
