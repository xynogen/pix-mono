# @xynogen/pix-hunk

Pi tool for driving a live [Hunk](https://github.com/modem-dev/hunk) diff review.
One `hunk` call accepts ordered `ops[]`, so an agent can inspect, navigate,
comment, highlight, and reload a review without repeated shell commands or
quoting.

## Requirements

Install Hunk and launch its interactive TUI in another terminal. This extension
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

## Install

```bash
pi install npm:@xynogen/pix-hunk
```

Standalone/opt-in: Hunk and a live local review session are required, so this
package is not bundled by `@xynogen/pix-core`.

## Scope ceiling

`comment apply`, STML markup, and comment clearing are intentionally omitted.
Use Hunk's CLI directly until repeated demand justifies extending the schema.

## License

MIT
