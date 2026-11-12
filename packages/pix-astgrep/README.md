<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-astgrep

AST-aware structural code search, symbol reads, and rewrites for Pi, built on
[ast-grep](https://ast-grep.github.io/). Match code by its syntax tree with
metavariables (`$A`, `$$$ARGS`) instead of text regex, read one named symbol
without loading a whole file, and rank files by identifier.

Standalone and opt-in — not bundled by `pix-core`, so the `ast` tool schema is
only present when you install it. Needs the `@ast-grep/napi` native addon (a
dependency, installed with the package).

## Tool

One deferred tool, `ast`, with six actions. The bundled `pix-astgrep` skill
(`read_skills(name="pix-astgrep", full=true)`) shows the outline-then-symbol read pattern and
safe rewrites.

| Action | Purpose |
|---|---|
| `search` | Structural search by pattern, e.g. `foo($A)` or `useState($$$)`. |
| `replace` | AST-aware rewrite (`pattern` → `rewrite`). Preview (line diff) by default; `apply:true` writes atomically. |
| `outline` | Syntax-only outline of a file or dir — declarations, imports, exports with line numbers. |
| `symbol` | Exact source of one named symbol (function, class, type, enum, const). |
| `enclosing` | Smallest named declaration that encloses a line — the reverse of `symbol`. |
| `symbols` | Rank files by how often they contain the query identifiers (AND-matched). |

## Languages

Six grammars are bundled and always work: `typescript`, `tsx`, `javascript`,
`jsx`, `css`, `html`.

Other languages (python, go, rust, java, c, cpp, and more) work in every tool.
`search` and `replace` take them through `lang`; the file actions detect
them from the file extension. The matching `@ast-grep/lang-*` grammar installs
on demand into the pix cache prefix after your consent — it never touches a
global path or this package's `node_modules`.

## Install

```bash
pi install npm:@xynogen/pix-astgrep
```

> Standalone and opt-in. [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core) does not bundle it. It needs the `@ast-grep/napi` native addon.

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
