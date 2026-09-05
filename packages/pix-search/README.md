# pix-search

Smarter `@` file search for [Pi Coding Agent](https://github.com/earendil-works/pi).

Wraps the built-in autocomplete provider to improve file ranking when you type `@` in the prompt:

- **Fuzzy scoring** — proper character-order matching with gap penalties and word-boundary bonuses (uses pi-tui's `fuzzyMatch`)
- **Git recency** — recently modified files (from `git log`) rank higher
- **Depth penalty** — shallower files win ties
- **Filename-only** — matches file *names/paths*, not file contents
- **Spaces in the query** — type `@foo bar` directly; the whole run after `@` is the query, so multi-word matches work without manually quoting (`@"foo bar"`). Picking a result inserts the properly-quoted path; press `Esc` to leave `@`-mode.

## Install

```bash
pi install npm:@xynogen/pix-search
```

Standalone — **not** bundled by `@xynogen/pix-core`.
