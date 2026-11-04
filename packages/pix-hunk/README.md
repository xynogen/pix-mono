<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-hunk

Pi tool for driving a live [Hunk](https://github.com/modem-dev/hunk) diff review.
One `hunk` call accepts ordered `ops[]`, so an agent can inspect, navigate,
comment, highlight, and reload a review without repeated shell commands or
quoting.

## Requirements

Launch Hunk's interactive TUI in another terminal. If `hunk` isn't found
(`~/.pi/agent/binary.json` → `~/.pi/agent/bin` → `PATH`), pix downloads the
official `modem-dev/hunk` release on first use and verifies it against
`SHA256SUMS`, with a visible status. This extension
only calls `hunk session *`; it never starts `hunk diff`, `show`, `patch`, or
another interactive command.

## Tool

```ts
hunk({
  ops: [
    { action: "review" },
    { action: "navigate", file: "src/App.tsx", hunk: 2 },
    {
      action: "comment",
      file: "src/App.tsx",
      newLine: 42,
      summary: "Handle the empty state",
    },
    { action: "comment_list", type: "user" },
  ],
});
```

Supported actions: `list`, `get`, `context`, `review`, `navigate`, `comment`,
`comment_list`, `comment_rm`, `highlight`, `highlight_clear`, and `reload`.
Operations execute in order and every result is returned, including failures.
Hunk JSON is converted to compact model-facing records:

```text
review s1 Working tree
  selected src/App.tsx:h2
  src/App.tsx +12 -4
    h1 old=10-14 new=10-18
comment c17 src/App.tsx:new:42 h1
comment_list
note-81bc src/App.tsx:new:47 h2 @xynogen: Can this branch be removed?
```

IDs come directly from Hunk. Successful records omit redundant numbering and
`ok`; failures use `action error: message`. TUI output auto-collapses to one
colored summary row; expanded UI hides internal IDs and comment bodies while
full model/audit data remains unchanged.

Model-facing output defaults to 10,000 characters. Set `maxCharacters` between
1,000 and 50,000 when more or less context is useful. Each operation receives a
quota, so a large patch cannot hide later results. Full structured results
remain available in tool details for inspection.

## Scope ceiling

`comment apply`, STML markup, and comment clearing are intentionally omitted.
Use Hunk's CLI directly until repeated demand justifies extending the schema.

## Install

```bash
pi install npm:@xynogen/pix-hunk
```

> Standalone and opt-in. [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core) does not bundle it. It needs the external Hunk CLI and a live review session.

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
