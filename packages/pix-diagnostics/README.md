# pix-diagnostics

Pi extension — an LSP client for project-selected language servers.

## What it does

- Reads language-server choices from `<project>/.pi/lsp.json`.
- Starts a configured server only when a visible tool call needs it.
- Reports diagnostics through `lens_diagnostics`.
- Supports definition, references, hover, symbols, rename preview, and call hierarchy through `lsp_navigation`.

Pix does not bundle, install, or select language servers. Use the `lsp` skill to
choose a server for the project. The project owns the server and its version.

## Project configuration

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

Required fields: `command`, `extensions`, and `languageId`. Optional fields:
`args`, `filenames`, and `rootMarkers`.

### Local TypeScript server

Install the server as a project development dependency:

```bash
bun add --dev typescript-language-server
```

TypeScript must also exist in the project dependencies.
Add this server to `<project>/.pi/lsp.json`:

```json
{
  "servers": {
    "typescript": {
      "command": "bun",
      "args": ["run", "typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
      "languageId": "typescript",
      "rootMarkers": ["tsconfig.base.json", "package.json", ".git"]
    }
  }
}
```

The wrapper uses the project-local server, not a global installation.
Run `/reload` after you change the server configuration.
Then call `lens_diagnostics` with `source: "lsp"` and explicit file paths.
This configuration does not add a JSON language server.

### Diagnostic states

- `clean`: the server confirms that the file has no findings.
- `findings`: the server returns one or more diagnostics.
- `unavailable`: no configured server can run for the file.
- `unconfirmed`: the client cannot confirm diagnostics within the wait budget.

An `unconfirmed` result does not mean that the file is clean.

## Install

```bash
pi install npm:@xynogen/pix-diagnostics
```

> Bundled in [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core). Install it alone only if you do not use pix-core.

## Full distro

This package is part of [Pix](https://github.com/xynogen/pix-mono). The installer sets up Pi and the full distro. See [Install](https://github.com/xynogen/pix-mono#install) for the notes for each OS.

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.ps1 | iex
```

## License

MIT

The LSP engine adapts code from `pi-lens` (MIT). See [LICENSE.pi-lens](LICENSE.pi-lens).
