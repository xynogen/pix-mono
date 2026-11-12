---
name: pix-python
description: How to use `python_run` for computation and data work — plain code instead of shell-quoted snippets, the right interpreter, and third-party packages in a managed venv. Use before parsing data, doing math, analysing logs or JSON, or any Python you would otherwise run through `bash`.
disable-model-invocation: true
---
# python_run — local Python snippets

Use it instead of `python3 -c` or `python3 - <<EOF` in `bash`. No shell quoting, and indentation is repaired.

| Field | Use |
|---|---|
| `intent` | Required. A short why, shown to the user. |
| `code` | Plain Python 3. `print()` what you need. |
| `python` | Only when the project needs its interpreter: `.venv`, a path, or `python3.12`. |
| `packages` | pip packages to install into the managed venv, e.g. `["openpyxl"]`. |

## Pattern

1. Write the script so it prints a small, final answer (counts, a table, the top N rows).
2. Read input files inside the script. Do not paste large data into `code`.
3. A missing module: run again with `packages`, or with `python` pointing at the project venv. Do not install with `bash pip`.

## Errors in history

| Error | Fix |
|---|---|
| `Traceback` / `Exit code: 1` | Read the last frame, fix the code, and run once more. |
| `File "<stdin>", line N` | A syntax error, often from shell-style quoting left in the code. |
| `spawn ... ENOENT` / `python path not found` | The `python` value is wrong. Omit it, or point at an existing `.venv`. |
| `openpyxl missing` | Add it to `packages`. |

## Do not

- Run long servers or watchers here. Use `proc`.
- Change project files from Python when `edit` or `write` can do it visibly.
