# pix-nudge

Pi extension — model-steering nudges (tools + capability).

## What it does

Registers two complementary nudge hooks. Both are surgical — they name only the relevant tool, not a full inventory.

**Tools nudge** — catches `bash` calls that reimplement a first-class tool (`read`, `ls`, `grep`, `find`, `edit`):

- Emits a YELLOW warning **once per command category per session**, redirecting to the proper tool.
- The command still runs — it teaches, doesn't block (early blocking wasted a turn on forced retry). Later calls in that category are silent.
- Bash stays available for everything else (pipes, compound commands, real shell work).

**Capability nudge** — steers the model toward tool discovery over guessing:

- One-time orientation block on the **first prompt** (tool counts, MCP tools, available skills).
- A one-line reminder every 10 turns pointing at `read_skills()` and `/toolbox`.
- When `graphify-out/graph.json` exists, both messages also route codebase questions to `graphify query`.

## Install

```bash
pi install npm:@xynogen/pix-nudge
```

> Also included in [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core):
>
> ```bash
> pi install npm:@xynogen/pix-core
> ```

## Full distro

Source: [github.com/xynogen/pix-mono](https://github.com/xynogen/pix-mono)

To install the complete pix suite (all packages + Pi itself):

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

## License

MIT
