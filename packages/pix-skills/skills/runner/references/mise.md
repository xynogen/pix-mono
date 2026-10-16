# mise (mise.toml)

- Environment block (`[env]`) at the top of the file
- Define tasks under `[tasks.<name>]`
- Use `description`, `depends`, `run` fields
- Group with comment headers (`# --- Group ---`)
- Validate: `mise tasks`
- **Standalone**: `[tasks.dev]` with `run = "command"`
- **Multi-step standalone**: `run = [...]` array for sequential commands
- **Simple parameterized**: bash `case` dispatch on `$1`, action interpolated directly
- **Complex parameterized**: bash `case` dispatch on `$1` with per-action logic
- **No `usage` field**: `usage` with `arg` enforces required args and errors before bash runs. Skip it — handle arg validation in bash instead.
- **Help on no arg**: When called without an action, print usage with action descriptions and `exit 0` (not `exit 1`). This makes bare `mise run <task>` a discoverable help command.

  ```toml
  [tasks.docker]
  description = "Docker operations (build|up|down)"
  run = '''
  #!/usr/bin/env bash
  set -euo pipefail
  action="${1:-}"
  if [ -z "$action" ]; then
    echo "Usage: mise run docker <action>"
    echo ""
    echo "Actions:"
    echo "  build  Build docker images"
    echo "  up     Start docker services"
    echo "  down   Stop docker services"
    exit 0
  fi
  docker compose -f docker-compose.dev.yml "$action"
  '''

  [tasks.test]
  description = "Test operations (unit|tidy)"
  run = '''
  #!/usr/bin/env bash
  set -euo pipefail
  action="${1:-}"
  if [ -z "$action" ]; then
    echo "Usage: mise run test <action>"
    echo ""
    echo "Actions:"
    echo "  unit    Run pytest"
    echo "  tidy    Remove caches and compiled files"
    exit 0
  fi
  case "$action" in
    unit)   python -m pytest -v ;;
    tidy)   find . -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true ;;
    *)      echo "Unknown action: $action"; exit 1 ;;
  esac
  '''

  [tasks.format]
  description = "Format operations — fix rewrites, check is dry-run for CI (fix|check)"
  run = '''
  #!/usr/bin/env bash
  set -euo pipefail
  action="${1:-fix}"
  if [ -z "$action" ]; then
    echo "Usage: mise run format <action>"
    echo ""
    echo "Actions:"
    echo "  fix    Reformat code in-place"
    echo "  check  Dry-run, exit 1 if changes needed (CI)"
    exit 0
  fi
  case "$action" in
    fix)   ruff format . && ruff check --fix . ;;
    check) ruff format --check . && ruff check . ;;
    *)     echo "Unknown action: $action"; exit 1 ;;
  esac
  '''

  [tasks.lint]
  description = "Lint operations (check|fix)"
  run = '''
  #!/usr/bin/env bash
  set -euo pipefail
  action="${1:-check}"
  case "$action" in
    check) ruff check . ;;
    fix)   ruff check --fix . ;;
    *)     echo "Unknown action: $action"; exit 1 ;;
  esac
  '''
  ```
