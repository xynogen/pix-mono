<!-- markdownlint-disable MD013 MD040 MD060 -->

# pix-mono — Architecture and Shared Layers

Moved out of `AGENTS.md` so it does not enter every system prompt. Read it before you add a package, a shared helper, or a cross-package import.

## 2. Architecture — how the framework is made

### 2.1 Layers

Pix is four layers. A package may import only from the layers below it, plus Pi itself.

```
┌──────────────────────────────────────────────────────────────────────┐
│ L3  pix-core            aggregator: imports every bundled member and │
│                         calls its factory, in a fixed order          │
├──────────────────────────────────────────────────────────────────────┤
│ L2  feature packages    one job each: a tool, a widget, a command    │
│     bundled:    pix-read write edit find grep ls bash powershell ask │
│                 todo welcome footer models update commands nudge     │
│                 diagnostics display prompts skills optimizer gate    │
│                 subagent                                             │
│     standalone: pix-9router voice web sudo ssh toolbox graph hunk    │
│                 mcp aria2 proc astgrep env search themes             │
├──────────────────────────────────────────────────────────────────────┤
│ L1  pix-pretty          rendering: frames, diffs, highlight, icons,  │
│     pix-data            model data: modelgrep + BenchLM caches       │
├──────────────────────────────────────────────────────────────────────┤
│ L0  pix-runtime         config, paths, binaries, exec, OS jobs, once │
├──────────────────────────────────────────────────────────────────────┤
│     Pi host (peer deps) @earendil-works/pi-coding-agent, pi-tui,     │
│                         pi-ai                                        │
└──────────────────────────────────────────────────────────────────────┘
```

Dependency facts (check with `jq .dependencies packages/<p>/package.json`):

- `pix-runtime` depends on no `pix-*` package. It is the floor.
- `pix-pretty` and `pix-data` depend only on `pix-runtime`.
- Almost every feature package depends on `pix-pretty` + `pix-runtime`. `pix-footer`, `pix-models`, `pix-subagent`, `pix-commands` and `pix-9router` also use `pix-data`.
- Two sanctioned sideways edges exist: `pix-skills` → `pix-gate/lib` (one safety policy for bash and skill directives). `pix-core` → every bundled member.
- `pix-toolbox` depends on `pix-pretty` only. Keep it independent of `pix-runtime`. `pix-themes` has no code and no deps.
- The per-package catalog (descriptions, bundled vs standalone) lives in [`.github/README.md`](.github/README.md). Do not copy it here.

### 2.2 How Pi loads a package

Pi does not walk npm dependencies. It activates only what an installed package declares in its own `package.json#pi` manifest:

```jsonc
"pi": {
  "extensions": ["src/extension.ts"],   // default-exported (pi: ExtensionAPI) => void
  "skills": ["./skills"],               // optional: pix-graph, pix-skills
  "themes": ["./themes"]                // optional: pix-themes
}
```

Pi loads extension files through **jiti** with `moduleCache: false`. TypeScript runs directly and modules re-evaluate on every load pass (`/new`, `/resume`, `/fork`, `/reload`). Two results follow:

1. **Module state does not survive a reload.** Process-wide singletons live on `globalThis` (the config runtime, the `once` registry, the icon mode).
2. **One factory can run twice against the same `pi`**: once from `pix-core`, once from a standalone install of the same package. Every factory wraps its body in `once(pi, "<pkg>", …)` from `@xynogen/pix-runtime/once`. The key is the `pi` instance, so a new `pi` after `/reload` registers again.

### 2.3 How pix-core bundles members

`pix-core` is a meta-package. `packages/pix-core/src/extension.ts` imports each member's factory through its public export and calls it in a fixed order:

```ts
import registerRuntime from "@xynogen/pix-runtime";
import registerData from "@xynogen/pix-data";
import registerPretty from "@xynogen/pix-pretty";
import registerRead from "@xynogen/pix-read/extension";
// …
const MEMBERS = [registerRuntime, registerData, registerPretty, /* features */ ] satisfies readonly PixExtension[];
export default function (pi: ExtensionAPI): void {
	for (const register of MEMBERS) register(pi);
}
```

Order matters:

- `pix-runtime` first. It owns `pix.json` init/reload/flush and `/pix`. Every config reader after it sees a live runtime.
- `pix-data` second. It warms the model caches.
- `pix-pretty` third. It seeds the icon mode before any `icon()` consumer paints.
- Features after that. `pix-core` also owns two features of its own: `compaction.ts` and `plan-mode.ts` (`/plan`).

A new bundled package needs three edits: a dependency in `packages/pix-core/package.json`, an import, and an entry in `MEMBERS`.

### 2.4 Anatomy of a small feature package

`pix-ls` is the reference shape:

```
packages/pix-ls/
  package.json     exports "." and "./extension", pi.extensions, files, deps, peerDeps
  README.md        user-facing docs for this package
  LICENSE
  src/
    extension.ts   Pi entry: once() guard, host wiring, calls the registrar
    ls.ts          the tool: schema, execute, renderCall/renderResult
    ls.test.ts     colocated test
    index.ts       public API (re-exports)
```

`package.json` essentials:

```jsonc
{
  "name": "@xynogen/pix-ls",
  "type": "module",
  "exports": { ".": "./src/index.ts", "./extension": "./src/extension.ts" },
  "files": ["src", "!src/**/*.test.*", "README.md", "LICENSE"],
  "pi": { "extensions": ["src/extension.ts"] },
  "dependencies": { "@xynogen/pix-pretty": "^1.19.0", "@xynogen/pix-runtime": "^0.12.2" },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-tui": "*" }
}
```

`extension.ts` stays thin. It resolves host pieces and hands them to a registrar that is easy to test:

```ts
export default function pixLsExtension(pi: ExtensionAPI): void {
	once(pi, "pix-ls", () => {
		const cwd = process.cwd();
		const home = homeDir();                               // pix-runtime/paths
		registerLsTool(pi as unknown as PiPrettyApi, createLsToolDefinition, {
			cwd,
			sp: (p) => shortPath(cwd, home, p),               // pix-pretty/utils
			TextComponent: viewportTextConstructor(Text),
			fffState,                                         // pix-pretty/fff
			cursorStore: new CursorStore(),
		});
	});
}
```

The tool file (`ls.ts`) then builds on shared pieces only: `frameToolResult`, `renderToolError`, `getErrorMessage` (`pix-pretty/utils`), batching (`pix-pretty/batch`), tree rendering (`pix-pretty/renderers`), and the collapse timer (`pix-runtime/collapse`). The package-local code is only what makes `ls` different from `read` or `grep`.

### 2.5 How imports resolve

- **In the repo:** Bun workspaces (`"workspaces": ["packages/*"]`) symlink every package into `node_modules/@xynogen/*`. `@xynogen/pix-pretty/utils` resolves through that package's `exports` map to its `src/*.ts` file. `tsconfig.base.json#paths` adds a few aliases for tsc.
- **For users:** npm installs each package with its caret-ranged `@xynogen/*` deps. The same `exports` map applies, so repo imports and published imports are the same.
- **In Pi during dev:** `bun run dev:link` symlinks workspace packages into Pi's extension `node_modules` and patches `settings.json` for packages with Pi resources. Restart Pi after you link or unlink.


---

## 3. Shared layers — what to use instead of writing your own

The shared layers exist so that 40 small packages look and behave like one product. **Before you write a helper, search these layers.** If the same helper appears in two packages, it belongs in a shared layer.

### 3.1 pix-runtime (L0) — host, config, OS

| Subpath | Use it for |
|---|---|
| `/once` | `once(pi, key, fn)`. The idempotency guard in every factory. |
| `/config` | `pixRuntime()`, `config(section)`. Sync reads of `~/.pi/agent/pix.json`. |
| `/sections` | Section handles: `collapseSection`, `prettySection`, `ioSection`, `compactionSection`, `optimizerSection`, `gateSection`. |
| `/collapse` | `shouldCollapse`, `collapseDelayMs`, `tickCollapse`. The auto-collapse policy for tool cards. |
| `/io` | `ioTimeoutMs()`, `ioTimeoutSignal(signal?)`. Every network call uses the user's `io.timeoutSec`. |
| `/paths` | `homeDir`, `expandHome`, `agentDir`, `binDir`, `projectDir`, `tempDir`, `cacheDir`. |
| `/exec` | `runTool`, `spawnTool`, `runToolSync`. Start a catalogued binary by name on any OS. |
| `/binaries` | `resolveTool`, `requireTool`, `ensureTool`. Path lookup and download. |
| `/os` | Per-OS jobs: `openTarget`, `runGit`, `readClipboardImage`. |
| `/which`, `/platform` | Executable lookup (PATHEXT-aware). Host description (glibc, WSL). |
| `/atomic-write` | `writeFileAtomicSync`. Readers never see a partial file. |
| `/safe-path` | Pre-flight check before a tool writes to a path the model chose. |
| `/lfid` | Short IDs that are easy for a model to read (`agent-happy-walrus-42`), not UUIDs. |
| `/audio` | Microphones, record, play. |
| `/icon-catalog` | The catalog source. Consumers import it through `pix-pretty/icon-catalog`. |
| `/testing` | `createIsolatedRuntime()`. A config runtime for tests that never touches the real agent dir. |

Add a config section: define it with `defineSection({ key, defaults, parse })` in `packages/pix-runtime/src/sections/`, export it from `sections/index.ts`, and read it with `config(mySection)`. `parse` must never throw. Use the coercion helpers in `schema.ts` (`isObj`, `boolOr`, `posNumOr`, …).

### 3.2 pix-pretty (L1) — rendering and display

| Subpath | Use it for |
|---|---|
| `/utils` | `frameToolResult`, `renderToolError`, `renderCollapsedToolRow`, `shortPath`, `dotJoin`, `pluralize`, `humanSize` (IEC bytes), `getErrorMessage`, `makeTextResult`, `termW`. |
| `/widget-format` | Live widgets: `SPINNER`, `formatMs`, `formatDuration`, `formatTokens`, `fmtTokenCount`, `formatContext`, `formatSpeed`, `describeActivity`, `getSessionContextUsage`. |
| `/batch` | Shared batching for read/grep/find/ls: N targets, one result, one byte cap. |
| `/diff`, `/diff-render` | Diff parsing and split/unified/word-level rendering. Colors follow the theme. |
| `/highlight`, `/lang` | Syntax highlighting and language detection. |
| `/renderers` | Tree and list renderers. |
| `/icon-catalog` | `icon("semantic.key")`. Never a raw glyph. |
| `/modal-frame` | `frameLines`, `modalWidth`. Rounded frame for overlays. |
| `/confirm` | Yes/No confirmation overlay. |
| `/progress` | Modal progress overlay. |
| `/gate-overlay` | The permission/root approval dialog only. |
| `/provider-picker` | Provider settings UI used by `/web` and `/voice`. |
| `/shell-tool` | Shared registrar + renderer for command-shell tools (bash, powershell). |
| `/transient-error` | `showTransientMessage`, `showTransientError`. One-line runtime diagnostics. |
| `/tool-status` | `reportToolStatus`, `warnBinaryMissing`. Binary download and missing-binary wording. |
| `/fff` | Shared FFF finder state for grep/find/ls. |
| `/types`, `/context` | Structural types (`ThemeLike`, `PiPrettyApi`, `ToolContext`). |
| `/test-utils` | Renderer test harness. Test-only. |
| `/ansi` | Base ANSI constants for renderers that must write raw escapes. |

### 3.3 pix-data (L1) — model metadata

`@xynogen/pix-data` exports `lookupModelsDev`, `resolveModelsDev`, `lookupBenchmark`, `benchScoreColor`, `formatCost` (`$3/$15` per 1M tokens), and the `DataSource` cache class. The factory warms the caches on session start. Consumers read them synchronously. Price, context and benchmark text must come from here, so the footer, `/models` and subagent all show the same numbers.

### 3.4 Pi itself

Pi's public API is also a shared layer. Prefer it when it fits: `truncateHead`/`truncateTail`, `DEFAULT_MAX_BYTES` (50KB) and `DEFAULT_MAX_LINES` (2000) for tool-output caps, `createXxxToolDefinition` for built-in tool replacements, and `pi-tui` components (`Text`, `SelectList`, `truncateToWidth`).

### 3.5 Why this improves quality

Each shared helper removes a class of bug from every consumer at once. Recent examples in this repo:

- `homeDir()` over `os.homedir()` / `process.env.HOME`: `HOME` is unset in a Windows Pi process, so the local copies made cwd-relative paths.
- `expandHome()` over hand-written `~` logic: one of the three copies missed `~\` on Windows.
- `ioTimeoutSignal()` over bare `fetch`: web requests now follow the user's `/pix` timeout, not a hardcoded value or none at all.
- `writeFileAtomicSync()` over `writeFileSync`: two concurrent writes of an MCP cache no longer corrupt it.
- `formatCost()`: three packages printed three different price formats.
- `getErrorMessage()`: 101 inline copies of `err instanceof Error ? err.message : String(err)` became one call.
- Pi `truncateHead` over three local truncators: one cap policy for every remote/root tool.

