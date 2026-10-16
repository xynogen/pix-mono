# justfile

- Use `set shell := ["bash", "-cu"]`
- Use `[group('Name')]` for categories
- Dependencies via `recipe: dep1 dep2`
- Comments above recipes become descriptions
- Validate: `just --list`
- **Standalone**: `recipe:` with direct command
- **Simple parameterized**: `recipe action:` where action passes through to the tool
- **Complex parameterized**: `recipe action:` with `if/else` dispatch in a bash block

  ```just
  # Docker operations (build|up|down)
  [group('Infra')]
  docker action:
      docker compose -f docker-compose.dev.yml {{action}}

  # Run unit tests or clean artifacts (unit|tidy)
  [group('test')]
  test action:
      #!/usr/bin/env bash
      set -euo pipefail
      case "{{action}}" in
        unit) pytest -v ;;
        tidy) find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true ;;
      esac

  # Format operations — fix rewrites, check is dry-run for CI (fix|check)
  [group('format')]
  format action="fix":
      #!/usr/bin/env bash
      set -euo pipefail
      case "{{action}}" in
        fix)   ruff format . && ruff check --fix . ;;
        check) ruff format --check . && ruff check . ;;
      esac

  # Lint operations — check reports issues, fix auto-corrects (check|fix)
  [group('format')]
  lint action="check":
      #!/usr/bin/env bash
      set -euo pipefail
      case "{{action}}" in
        check) ruff check . ;;
        fix)   ruff check --fix . ;;
      esac
  ```
