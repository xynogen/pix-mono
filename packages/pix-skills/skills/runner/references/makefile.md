# Makefile

- Set `SHELL := /bin/bash` and `.DEFAULT_GOAL := help`
- Declare all targets in `.PHONY`
- Use `## comment` after target for help text, generate a `help` target with `grep -E`
- Dependencies via `target: dep1 dep2`
- Group with comment headers (`# --- Group ---`)
- Validate: `make help`
- **Standalone**: standard target with direct commands
- **Simple parameterized**: pattern rule `docker-%:` dispatching to `docker compose $*`
- **Complex parameterized**: pattern rule `test-%:` with per-target recipes

  ```makefile
  .PHONY: docker-% test-% format-% lint

  docker-%: ## Docker operations (build|up|down)
   docker compose -f docker-compose.dev.yml $*

  test-unit: ## Run unit tests
   pytest -v
  test-tidy: ## Clean build artifacts
   find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

  format-fix: ## Reformat code
   ruff format . && ruff check --fix .
  format-check: ## Dry-run format check (CI)
   ruff format --check . && ruff check .

  lint-check: ## Lint — report issues
   ruff check .
  lint-fix: ## Lint — auto-correct
   ruff check --fix .
  ```
