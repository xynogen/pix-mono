<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-search

`@` file picker overlay for [Pi Coding Agent](https://github.com/earendil-works/pi).

Typing `@` at a token boundary (line start or after whitespace) opens a modal
file picker with its own query input:

- **Files and folders** — pick a file to point the model at it, or a folder to
  scope work to a whole directory. Folders appear with a trailing `/`.
- **Live preview** — on wide terminals a side pane shows the selection: a file's
  first lines with syntax highlighting, or a folder's immediate file list.
- **File-type icons & colors** — results show Nerd Font file/folder icons and
  type-colored names (respects `PRETTY_ICONS`).
- **Spaces in the query** — the picker owns keyboard focus, so `@` then `my file`
  filters on the full phrase with no `@"…"` quoting.
- **Name-based** — matches file/folder *names and paths*, not file contents.
- **Fuzzy scoring** — character-order matching with word-boundary bonuses.
- **Git recency** — recently modified files (from `git log`) rank higher.
- **Depth penalty** — shallower entries win ties.

Picking a result inserts `<path>…</path>` into the prompt; the model receives
that span verbatim, and `@xynogen/pix-display` renders it as an `@name` chip
when installed. Keys: `↑`/`↓` move, `⏎` insert, `Esc` cancel (a cancelled
pick inserts a literal `@`, so the keystroke is never swallowed).

`@` mid-token (e.g. an email `user@host`) is left as a literal `@` — only a
boundary `@` opens the picker.

## Install

```bash
pi install npm:@xynogen/pix-search
```

> Standalone and opt-in. [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core) does not bundle it. It replaces Pi's built-in `@` autocomplete. It wraps the installed editor, so it works with `pix-display` in either load order.

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

MIT. See [LICENSE](LICENSE).
