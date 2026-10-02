---
name: lsp
description: Select and configure a project language server for pix-diagnostics. Use when LSP is missing, unavailable, or needs setup for a language.
disable-model-invocation: true
---
# Project LSP Setup

`pix-diagnostics` is only an LSP client. The project owns the server choice and
installation. Configure it in `<project>/.pi/lsp.json`.

## Steps

1. Detect the language from project files and manifests.
2. Prefer an existing server in project dependencies or on `PATH`.
3. Ask before installing a missing server. Use a project-local install.
4. Add only the selected language to `.pi/lsp.json`.
5. Run `lens_diagnostics` on one source file. Its manager reads `.pi/lsp.json` directly.

Do not add all languages. Do not install a server globally. Do not use a server
because it appears first in this table; project configuration and existing tools
win.

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

Check official server documentation when a command is not in this table.

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

Use one command. Wrapper commands such as `uv` or `bunx` can be the command,
with the server command in `args`:

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
