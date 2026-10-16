---
name: lsp
description: Selects, installs with consent, and configures a project language server in .pi/lsp.json for pix-diagnostics, then confirms it with lsp_diagnostics. Use when LSP diagnostics or navigation are missing, unavailable, or need setup for a language.
disable-model-invocation: true
---
# Project LSP Setup

`pix-diagnostics` is only an LSP client. The project owns the server choice and
installation. Configure it in `<project>/.pi/lsp.json`.

## Steps

1. Detect the language from project files and manifests.
2. Prefer an existing server in project dependencies or on `PATH`.
3. Ask before installing a missing server. Prefer a project-local install (dev dependency, `uv` group). For servers with no local form (`gopls`, `rust-analyzer`, `clangd`, `terraform-ls`, `lua-language-server`), ask how the user wants it installed.
4. Add only the selected language to `.pi/lsp.json`. Never add every language.
5. Run `lsp_diagnostics` on one source file.
6. Report: language, server, config path, and the result. If the server fails to start or returns an error, report it and stop. Do not try another server without asking.

## Common choices

| Language | Server command | Arguments |
|---|---|---|
| TypeScript / JavaScript | `typescript-language-server` | `--stdio` |
| Python | `pyright-langserver` | `--stdio` |
| Python (basedpyright project) | `basedpyright-langserver` | `--stdio` |
| Go | `gopls` | — |
| Rust | `rust-analyzer` | — |
| C / C++ | `clangd` | — |
| Ruby | `ruby-lsp` | — |
| PHP | `intelephense` | `--stdio` |
| Lua | `lua-language-server` | — |
| Kotlin | `kotlin-lsp` | — |
| Terraform | `terraform-ls` | `serve` |
| YAML | `yaml-language-server` | `--stdio` |
| JSON | `vscode-json-language-server` | `--stdio` |
| HTML | `vscode-html-language-server` | `--stdio` |
| CSS | `vscode-css-language-server` | `--stdio` |
| TOML | `taplo` | `lsp stdio` |

For other languages (Java, C#, Swift, Bash, ...), check the official server docs. Do not guess the command.

## Config shape

```json
{
  "servers": {
    "python": {
      "command": "pyright-langserver",
      "args": ["--stdio"],
      "extensions": [".py", ".pyi"],
      "languageId": "python",
      "rootMarkers": ["pyproject.toml", ".git"]
    }
  }
}
```

Each key is a server ID. Required fields are `command`, `extensions`, and
`languageId`. Optional fields are `args`, `filenames`, and `rootMarkers`.

`command` is the executable. For a wrapper such as `uv` or `bunx`, put the wrapper in `command` and the server in `args`:

```json
{
  "servers": {
    "python": {
      "command": "uv",
      "args": ["run", "pyright-langserver", "--stdio"],
      "extensions": [".py", ".pyi"],
      "languageId": "python",
      "rootMarkers": ["pyproject.toml", ".git"]
    }
  }
}
```
