# pix-prompts

Pi extension — system-prompt injection (SOP.md + repo directives).

## What it does

Injects structured context into the system prompt at the start of every agent turn via `before_agent_start`. It first replaces Pi's default coding-assistant identity line with `You are Pix Coding Agent. You help users accomplish any task they request.` Two sources are then injected in order: the bundled `SOP.md` (the pix agent operating spec baseline), followed by repo-root directive files the Pi host does not load (`GEMINI.md`, `.cursorrules`, `.windsurfrules`). Each source is wrapped in a labelled XML tag for provenance.

Injection is **idempotent and host-aware**. A file is skipped when either our own tag is already present (retry turns) or the Pi host has injected that same absolute path as `<project_instructions path="...">`. Pi natively owns `AGENTS.md` and `CLAUDE.md`; pix-prompts intentionally does not scan them, preventing duplicate injection when host and extension paths use different normalization.

## Install

```bash
pi install npm:@xynogen/pix-prompts
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
