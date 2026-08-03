# pix-nudge

Pi extension — model-steering nudges (tools + capability).

## What it does

Registers two complementary nudge hooks. The **tools nudge** intercepts `bash` tool calls that merely reimplement a first-class tool (`read`, `ls`, `grep`, `find`, `edit`) and emits a YELLOW warning notification ONCE per command category per session, redirecting the model to use the proper tool instead. The command still runs — the nudge teaches for next time, it does not block (early blocking wasted a turn via forced retry). After the first nudge for a category, subsequent bash calls in that category are silent. Bash stays available for everything else (pipes, compound commands, real shell work).

The **capability nudge** injects a one-time orientation block on the FIRST prompt of each session (tool counts, MCP tools, available skills) and a short one-line reminder every 10 turns, steering the model toward `read_skills()` and the `/toolbox` command for tool discovery rather than guessing. When `graphify-out/graph.json` exists in the working directory, both messages also direct codebase questions to `graphify query`. Both nudges are surgical: they name only the relevant tool, not a full inventory.

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
