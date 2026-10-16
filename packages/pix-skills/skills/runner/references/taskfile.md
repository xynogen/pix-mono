# Taskfile.yml (go-task)

- Use `version: '3'`
- Define under `tasks:` with `desc`, `deps`, `cmds`
- Group with comment headers
- Validate: `task --list`
- **Standalone**: single task with `cmds` list
- **Simple parameterized**: `{{.CLI_ARGS}}` passed through to the underlying tool
- **Complex parameterized**: internal tasks per action, parent dispatches via `task test-{{.CLI_ARGS}}`

  ```yaml
  tasks:
    docker:
      desc: "Docker operations (build|up|down)"
      cmds:
        - docker compose -f docker-compose.dev.yml {{.CLI_ARGS}}

    test:
      desc: "Test operations (unit|tidy)"
      cmds:
        - task: "test-{{.CLI_ARGS}}"
    test-unit:
      internal: true
      cmds: [pytest -v]
    test-tidy:
      internal: true
      cmds: ["find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true"]

    format:
      desc: "Format operations (fix|check)"
      cmds:
        - task: "format-{{.CLI_ARGS}}"
    format-fix:
      internal: true
      cmds: [ruff format ., ruff check --fix .]
    format-check:
      internal: true
      cmds: [ruff format --check ., ruff check .]

    lint:
      desc: "Lint operations (check|fix)"
      cmds:
        - task: "lint-{{.CLI_ARGS}}"
    lint-check:
      internal: true
      cmds: [ruff check .]
    lint-fix:
      internal: true
      cmds: [ruff check --fix .]
  ```
