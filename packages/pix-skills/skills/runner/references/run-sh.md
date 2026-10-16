# run.sh (shell script)

- `#!/usr/bin/env bash` with `set -euo pipefail`
- Each task as `cmd_<name>()` function
- Dispatch via `main()` with case/declare lookup
- Help via `cmd_help()` listing all commands
- Validate: `./run.sh help`
- **Standalone**: `cmd_dev()` with direct command
- **Parameterized**: `cmd_<name>()` takes `$1` as action, inner `case` dispatch

  ```bash
  cmd_docker() {
      local action="${1:?Usage: $0 docker <build|up|down>}"
      case "$action" in
          build|up|down) docker compose -f docker-compose.dev.yml "$action" ;;
          *) echo "Unknown action: $action"; exit 1 ;;
      esac
  }

  cmd_test() {
      local action="${1:?Usage: $0 test <unit|tidy>}"
      case "$action" in
          unit) pytest -v ;;
          tidy) find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true ;;
          *)    echo "Unknown action: $action"; exit 1 ;;
      esac
  }

  cmd_format() {
      local action="${1:-fix}"
      case "$action" in
          fix)   ruff format . && ruff check --fix . ;;
          check) ruff format --check . && ruff check . ;;
          *)     echo "Unknown action: $action"; exit 1 ;;
      esac
  }

  cmd_lint() {
      local action="${1:-check}"
      case "$action" in
          check) ruff check . ;;
          fix)   ruff check --fix . ;;
          *)     echo "Unknown action: $action"; exit 1 ;;
      esac
  }
  ```
