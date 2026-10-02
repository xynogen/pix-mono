---
name: lint
description: Select and run the project's linter through bash. Use when asked to lint, fix lint findings, or check code quality.
disable-model-invocation: true
---
# Project Lint

Pix does not bundle linters. Use the project toolchain.

## Selection order

1. Run `lens_diagnostics` for language-server diagnostics.
2. Prefer the project's `lint` or `check` script.
3. Use the tool named by a project config file.
4. Use the language default below only when the project has no choice.

Do not install a missing linter without user consent. Prefer project-local
installation. Run changed files instead of the full tree when the tool permits.

## Defaults

| Language | Lint command |
|---|---|
| JavaScript / TypeScript | `biome check <paths>` or `eslint <paths>` |
| Python | `ruff check <paths>` |
| Go | `go vet ./...` then `golangci-lint run` |
| Rust | `cargo clippy` |
| Ruby | `rubocop <paths>` |
| Java | `mvn checkstyle:check` or `gradle check` |
| Kotlin | `ktlint` or `detekt` |
| C / C++ | `clang-tidy` or `cppcheck <paths>` |
| C# | `dotnet format --verify-no-changes` |
| Swift | `swiftlint` |
| PHP | `phpstan analyse` |
| Elixir | `mix credo` |
| Shell | `shellcheck <paths>` |
| SQL | `sqlfluff lint <paths>` |
| YAML | `yamllint <paths>` |
| CSS | `stylelint <paths>` |
| HTML | `htmlhint <paths>` |
| Markdown | `markdownlint <paths>` |
| TOML | `taplo lint <paths>` |
| Docker | `hadolint <Dockerfile>` |
| GitHub Actions | `actionlint` |
| Terraform | `tflint` |

Use the local package manager: `bun run`/`bunx`, `npm run`/`npx`, `pnpm exec`,
`yarn`, `uv run`, or `poetry run`. A project script wins over this table.
