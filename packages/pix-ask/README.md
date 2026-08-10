# pix-ask

Pi tool — structured questionnaire UI (`ask_user`).

## What it does

Registers the `ask_user` tool in Pi. When the agent needs to resolve ambiguous requirements, it presents up to 4 structured multiple-choice questions in a TUI dialog. Each question requires 2–4 options with labels and descriptions; supports multi-select and markdown side-by-side previews for richer context. Single-select questions (without a preview) auto-append a "Type something." row for free-form input; multi-select questions append a "Next" row to advance. Single-select questions with a `preview` skip the free-form row to make room for the side-by-side layout. In non-interactive (RPC/JSON) mode, falls back to text-based prompts. The agent uses this tool before proceeding rather than guessing at intent.

While the dialog is open, `ask_user` holds the shared **agent-state** coordinator in the `blocked` state (via `withAgentBlock` from [`@xynogen/pix-runtime`](https://www.npmjs.com/package/@xynogen/pix-runtime)). Inside a herdr pane that transition fires a "needs attention" notification, so a user away from the terminal is pinged when a question is waiting.

## Install

```bash
pi install npm:@xynogen/pix-ask
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
