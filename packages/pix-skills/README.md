# pix-skills

Pi coding agent extension — skill loader tool + skills bundle.

## What's included

| Resource | Type | Description |
|---|---|---|
| `read_skills` | tool | Browse local skills, search Skills.sh, explicitly fetch/cache a selected public GitHub skill, read references, and copy bundled resources. |
| `skills/` | skills | 33 bundled skills (off-context by default — discovered on demand via `read_skills`) |

## New: Skills.sh search and remote skill cache

`read_skills` can discover skills from [Skills.sh](https://skills.sh/) and cache a selected skill from its public GitHub repository. Discovery and loading are intentionally separate:

```text
# 1. Search only—nothing is downloaded or loaded
read_skills(search="hallmark")

# 2. Review the results, then explicitly fetch and load one
read_skills(source="nutlope/hallmark", name="hallmark", full=true)

# 3. Optionally update an already-cached skill
read_skills(source="nutlope/hallmark", name="hallmark", full=true, refresh=true)
```

Remote skills are cached under `~/.cache/pi/skills.sh/` (or `$XDG_CACHE_HOME/pi/skills.sh/` when configured). A missing local skill is never fetched automatically, and search results never trigger a download. See [Remote skill security](#remote-skill-security) for the trust boundaries.

## `$` skill picker

Type `$` at a token boundary (line start or after whitespace) to open a skill picker. It lists local skills (fuzzy by name) and, after 2+ query characters, Skills.sh search results. `⏎` inserts `<skill>name</skill>` (local) or `<skill>owner/repo@name</skill>` (Skills.sh). On submit, pix-skills replaces each token with the skill body in Pi's `<skill name location>` format, so the transcript shows a collapsible skill card, the same as `/skill:name`. A Skills.sh token fetches and caches the bundle at submit time and carries an untrusted-content notice. Remote skills never run command directives. A token that fails to load stays in the text, and Pi shows an error notice. `Esc`, a mid-word `$`, and a pasted `$` keep a literal `$`.

To make `$` the only way to pick a skill, set `"enableSkillCommands": false` in `~/.pi/agent/settings.json`. That hides Pi's `/skill:name` entries from the `/` menu.

## How it works

Bundled skills are **off-context by default**: every skill carries `disable-model-invocation: true` in
its frontmatter, so pi does **not** inject its description into the system prompt at startup. This keeps
the baseline context small regardless of how many skills ship.

Discovery and loading go through the `read_skills` tool instead:

- `read_skills()` — lists skill names only in one horizontal line (independent dir scan, not the prompt registry)
- `read_skills(name=<skill>)` — reads one skill's description
- `read_skills(name=<skill>, full=true)` — loads the full procedure into context
- `read_skills(name=<skill>, resource=references/<path>)` — reads a UTF-8 reference into context
- `read_skills(name=<skill>, resource=<path>, output=<path>)` — copies a reference, script, or asset into the current project
- `read_skills(search=<query>)` — searches Skills.sh without loading anything
- `read_skills(source=<owner/repo>, name=<skill>, full=true)` — explicitly fetches, caches, and loads the selected public GitHub skill
- add `refresh=true` to re-fetch a remote bundle instead of using the cache

### Remote skill security

Remote loading deliberately uses two calls: search results are informational and never auto-loaded. A selected bundle is fetched only from a validated public GitHub `owner/repo`, matched by its `SKILL.md` frontmatter name, bounded by file/byte limits, and cached under `~/.cache/pi/skills.sh/` (or `$XDG_CACHE_HOME/pi/skills.sh/`). Only `SKILL.md` and conventional `references/`, `scripts/`, and `assets/` files are retained. Remote instructions are marked as untrusted and remain subordinate to system, developer, and user instructions. Remote command interpolation is disabled, and scripts and assets are never executed by `read_skills`.

A skill can opt back into passive prompt injection by **removing** the `disable-model-invocation: true`
line (or setting it to `false`) — then pi auto-loads its description on description match. The bundled
set deliberately leaves it on to favour a lean context.

Skills are also discovered from `~/.pi/agent/skills/` (user-level). Bundled skills take precedence on name collision.

## Skill layout and bundled resources

`pix-skills` recognizes both the current flat layout and a directory bundle:

```text
skills/
├── debug.md                 # current flat layout
└── debug/
    └── SKILL.md             # equivalent minimal bundle layout
```

A bundle needs only `SKILL.md`. It may add resource directories when the skill
actually needs them:

```text
skills/docx/
├── SKILL.md                 # required
├── scripts/                 # optional executable source files
├── references/              # optional text/documentation resources
└── assets/                  # optional data, templates, images, or themes
```

The bundle relies exclusively on this conventional folder structure—there is
no separate metadata file. `SKILL.md` frontmatter is the single source of truth
for skill metadata, while the presence and contents of `scripts/`, `references/`,
and `assets/` define the available resources. Empty resource directories do not
need to be created.

### Resource access

References may be read directly into model context or copied into the current
project. Scripts and assets are never returned to context; they require an
explicit project-relative `output` and are copied as raw bytes:

```text
# Read a small reference into context (1 MiB text limit)
read_skills(name="docx", resource="references/compatibility.md")

# Copy a large reference without adding it to context
read_skills(
  name="docx",
  resource="references/specification.pdf",
  output=".pi/resources/docx/specification.pdf"
)

# Materialize scripts and binary assets before using them
read_skills(
  name="docx",
  resource="scripts/render.ts",
  output=".pi/tools/docx/render.ts"
)
read_skills(
  name="docx",
  resource="assets/template.docx",
  output=".pi/tools/docx/template.docx"
)
```

Copying does not execute a script. It creates missing destination directories
and atomically replaces the destination with the bundled file. The agent can
then use ordinary tools to inspect or run the copied resource.

Resource resolution will be confined to the selected skill bundle:

- only `scripts/`, `references/`, and `assets/` are addressable;
- absolute paths and `..` traversal are rejected;
- symlinks that resolve outside the canonical skill root are rejected;
- flat skills such as `skills/debug.md` have no resource root and therefore
  cannot read neighboring skills or files;
- callers use bundle-relative names and never need an absolute `${SKILL_DIR}`;
- `output` is relative to the current project working directory;
- invalid source or output paths—including paths outside the permitted roots,
  absolute paths, traversal, and escaping symlinks—are rejected.

`read_skills` is the safe version of "agent prompts itself":

- Agent calls tool explicitly — no autonomous injection
- Orchestrator (user or system prompt) decides when skill loading is appropriate
- Auditable: tool call is visible in the conversation

## Skills

All bundled skills ship with `disable-model-invocation: true`, so they stay out of the system prompt
until the agent loads one explicitly via `read_skills(name=<skill>, full=true)`. They remain invokable
as `/skill:<name>` slash commands.

| Skill | Description |
|---|---|
| `ask-user` | Ask 1–4 structured questions before high-stakes, irreversible, or ambiguous decisions |
| `audit` | Security audit, integrity check, and secret/vulnerability scan with evidence |
| `bootstrap` | Scaffold a new project or tool from authoritative docs, with install consent |
| `brainstorm` | Design exploration and spec refinement before implementation |
| `cicd` | Two-stage CI/CD release pipeline (validate on push/PR, publish the tested artifact on tag) |
| `clone` | Clone a git repo into `/tmp/clones` for read-only exploration |
| `command-runner` | Inspect workspace health from pre-populated git status + diff |
| `commit` | Split, write, and maintain Conventional-Commit-style commits; secret checks |
| `composio-mcp` | Safe Composio MCP workflow — prefer direct servers, introspect before writing |
| `debug` | Root-cause analysis: reproduce, isolate, fix, and prove |
| `diff` | Review current git changes from pre-populated staged/unstaged diffs |
| `environment` | Detect OS/distro/kernel/arch before platform-specific commands |
| `explain` | Trace and explain existing code in plain STE-style language |
| `finish` | Branch completion — verify, decide merge/PR/keep, clean up |
| `format` | Select and run the project's formatter, check mode before write mode |
| `handoff` | Toggle session handoff — write or read+delete `HANDOFF.md` |
| `harden` | Retrofit a fail-fast static-analysis gate onto an existing project |
| `human` | Audit and rewrite text to remove AI writing patterns (bundle with references) |
| `lint` | Select and run the project's linter (LSP diagnostics first) and fix findings |
| `long-task` | Multi-session build state in files: `init.sh`, `features.json`, `PROGRESS.md`, one commit per feature |
| `lsp` | Select, install with consent, and configure a language server in `.pi/lsp.json` |
| `readme` | Create or update a deployment-focused README in a fixed style |
| `review` | Strict code review by severity, ending in a Pass / Pass with suggestions / Fail verdict |
| `runner` | Generate or convert a task runner (just/make/mise/task/npm/sh; bundle with references) |
| `search` | Deep code discovery and project context mapping with grep, graph, and LSP |
| `subagent` | Decompose work and fan out independent units to parallel `agent` workers |
| `suggest` | Ranked optimization and improvement recommendations |
| `task` | Task orchestration and ambiguity resolution |
| `tdd` | Test-first development: red, green, refactor |
| `test` | Run tests, analyze failures, and fix them |
| `tldr` | Maximum-density technical summary, zero filler |
| `toon-json` | Shrink dense JSON for context with jq + TOON |
| `ui` | UI/UX design and implementation guidance for frontends |
| `verify` | Verification before completion — prove it is actually fixed |

## Command interpolation

Skill `.md` files may embed live command output with the `` !`cmd` `` directive.
When the agent loads a skill with `read_skills(name=<skill>, full=true)`, each
directive is evaluated and replaced inline with a fenced block holding the
command's output — so the skill arrives pre-populated with live workspace
context (e.g. `git status`).

```markdown
### Working tree status
!`git status -s`
```

### Security — pix-gate is the policy (no prompt)

Directive commands are gated by the **same rule engine** as the `bash` tool
(`@xynogen/pix-gate`), but with **no confirmation dialog**:

- **Auto-deny on any rule match.** If a command matches any pix-gate rule
  (critical / dangerous / risky), it is **not run** — the directive is replaced
  with an inline `[blocked: <severity> — <reason>]` marker so the skill author
  can see and fix it.
- **Shell-free execution.** Commands run via a direct `argv` spawn (never
  `bash -c`). Any shell metacharacter (`; | & $ \` > < ( ) { }`, newline) is
  rejected, so a clean-looking prefix can't smuggle a chained command.
- **Bounded.** Per-command 10s timeout and 16 KB output cap; failures never
  throw — they inline a marker so skill loading always completes.
- **Escape.** `` \!`cmd` `` is left literal, so docs can show the syntax without
  running it.
- **Single source of truth.** Expanding pix-gate's rule table or a user's
  `~/.pi/agent/pix-gate.json` automatically tightens the skill path too.

Interpolation only happens on the `full=true` path; name listing and description
lookups never run commands. Calls and results identify the operation as `list`,
`description`, `instructions`, `reference`, or `copy`; instruction results preview
at most the first 100 characters, while the full content still reaches the agent.
Copied-resource results show
the destination and byte size. Tool results follow Pix's configured auto-collapse
delay, including `read_skills`; expanding an elapsed result restores its normal
preview without clearing or restarting the collapse timer.

## Usage

```
# Agent lists available skills (no args)
read_skills()

# Agent reads description of a specific skill
read_skills(name="commit")

# Agent loads full commit procedure
read_skills(name="commit", full=true)

# Search Skills.sh (does not load a result)
read_skills(search="anti-slop design")

# Explicitly fetch/cache one selected result, then load it
read_skills(source="nutlope/hallmark", name="hallmark", full=true)

# Re-fetch the selected remote skill
read_skills(source="nutlope/hallmark", name="hallmark", full=true, refresh=true)

# Read a UTF-8 reference into context
read_skills(name="docx", resource="references/compatibility.md")

# Copy a script or asset to the current project without loading it into context
read_skills(
  name="docx",
  resource="scripts/render.ts",
  output=".pi/tools/docx/render.ts"
)
```

## Install

```bash
pi install npm:@xynogen/pix-skills
```

> Bundled in [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core). Install it alone only if you do not use pix-core.

Or from the monorepo:

```bash
pi install ./packages/pix-skills
```

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
