# pix-commands

Pi extension providing focused slash commands:

- `/clear` — flush Pi's cached model data.
- `/btw <question>` — ask an isolated side question without interrupting the main agent.
- `/afk` — toggle AFK mode for unattended runs.

## `/clear`

Deletes `~/.cache/pi` to flush stale model-data cache, then prompts you to run `/reload`.

## `/btw`

`/btw` runs a separate in-memory child session concurrently with the main agent:

```text
/btw what is the difference between a mutex and a semaphore?
```

The child session:

- starts with an empty conversation and a lean Pix system prompt;
- snapshots the main session's model, thinking level, active tools, credentials, extensions, and working directory;
- never imports the main conversation;
- publishes its Markdown answer in a visually distinct side-thread card;
- keeps rendered BTW answers out of future main-agent LLM context;
- supports multiple concurrent side questions.

When the main agent is streaming, completion is shown as a notification and the durable card is appended after the main session becomes idle. This prevents the side answer from becoming steering input.

## `/afk`

`/afk` toggles AFK mode (away-from-keyboard) for unattended runs. It is a shared
toggle stored in a global flag and shown in the status bar.

When ON, yellow (medium-risk) permission gates auto-allow, while red (dangerous)
gates and sudo prompts auto-deny:

```text
AFK mode on — yellow gates auto-allow; red and sudo auto-deny.
```

When OFF (the default), normal approval prompts are restored:

```text
AFK mode off — approval prompts restored.
```

The point is to let the agent keep working on safe, medium-risk actions while you
are away, without silently permitting destructive ones. It pairs with the herdr
notification bridge in `pix-runtime`: you still get pinged when something truly
needs you (a red gate or sudo), and auto-deny turns that into a stop rather than
an approval.

## Install

```bash
pi install npm:@xynogen/pix-commands
```

> Also included in [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core):
>
> ```bash
> pi install npm:@xynogen/pix-core
> ```

## Full distro

Source: [github.com/xynogen/pix-mono](https://github.com/xynogen/pix-mono)

To install the complete pix suite:

```bash
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

## License

MIT
