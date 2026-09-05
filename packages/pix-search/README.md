# pix-search

`@` file picker overlay for [Pi Coding Agent](https://github.com/earendil-works/pi).

Typing `@` at a token boundary (line start or after whitespace) opens a modal
file picker with its own query input:

- **Spaces in the query** — the picker owns keyboard focus, so `@` then `my file`
  filters on the full phrase with no `@"…"` quoting.
- **Filename-only** — matches file *names/paths*, not file contents.
- **Fuzzy scoring** — character-order matching with word-boundary bonuses.
- **Git recency** — recently modified files (from `git log`) rank higher.
- **Depth penalty** — shallower files win ties.

Picking a result inserts the path into the prompt (quoted automatically when it
contains a space). Keys: `↑`/`↓` move, `⏎` insert, `Esc` cancel (a cancelled
pick inserts a literal `@`, so the keystroke is never swallowed).

`@` mid-token (e.g. an email `user@host`) is left as a literal `@` — only a
boundary `@` opens the picker.

## Install

```bash
pi install npm:@xynogen/pix-search
```

Standalone — **not** bundled by `@xynogen/pix-core`. It replaces the input
editor component (via `setEditorComponent`), so run it alone if another
extension also customizes the editor.
