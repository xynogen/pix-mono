---
name: format
description: Select and run the project's formatter through bash. Use when asked to format code, check formatting, or apply style fixes.
disable-model-invocation: true
---
# Project Format

Pix does not bundle formatters. Use the project toolchain.

## Selection order

1. Prefer the project's `format` or `fmt` script.
2. Use the tool named by a project config file.
3. Use the language default below only when the project has no choice.

Run the check form first. Run the write form only when the user asks to format
or already approved edits. Do not install a missing formatter without consent.

## Defaults

| Language | Check | Write |
|---|---|---|
| JavaScript / TypeScript | `biome format <paths>` or `prettier -c <paths>` | `biome format --write <paths>` or `prettier -w <paths>` |
| Python | `ruff format --check <paths>` or `black --check <paths>` | `ruff format <paths>` or `black <paths>` |
| Go | `test -z "$(gofmt -l <paths>)"` | `gofmt -w <paths>` |
| Rust | `cargo fmt --check` | `cargo fmt` |
| Ruby | `rubocop --format-only <paths>` | `rubocop -A <paths>` |
| Java | `google-java-format --dry-run <paths>` | `google-java-format -i <paths>` |
| Kotlin | `ktlint --format` | `ktlint -F` |
| C / C++ | `clang-format --dry-run --Werror <paths>` | `clang-format -i <paths>` |
| C# | `dotnet format --verify-no-changes` | `dotnet format` |
| Swift | `swift-format lint <paths>` | `swift-format -i <paths>` |
| PHP | `php-cs-fixer fix --dry-run` | `php-cs-fixer fix` |
| Elixir | `mix format --check-formatted` | `mix format` |
| Shell | `shfmt -d <paths>` | `shfmt -w <paths>` |
| SQL | `sqlfluff format --check <paths>` | `sqlfluff fix <paths>` |
| CSS / HTML / Markdown | `prettier -c <paths>` | `prettier -w <paths>` |
| TOML | `taplo fmt --check <paths>` | `taplo fmt <paths>` |
| Terraform | `terraform fmt -check` | `terraform fmt` |

Use the local package manager: `bun run`/`bunx`, `npm run`/`npx`, `pnpm exec`,
`yarn`, `uv run`, or `poetry run`. A project script wins over this table.
