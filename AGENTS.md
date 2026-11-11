# Pix — Agent Guide

## Architecture and ownership

- Keep feature tools focused on business logic: input rules, approval policy, the operation, and domain-specific results.
- Put reusable execution and resource lifecycle in `pix-runtime`; UI components and their lifecycle belong in `pix-pretty`; model metadata belongs in `pix-data`.
- Shared layers do not depend on feature packages. `pix-core` composes packages; it is not a utility layer.
- Use lower-layer public exports across packages, not filesystem paths or source internals. Do not introduce feature-to-feature dependencies.
- Pi reloads extension modules without preserving module-local state. Check the existing runtime load guard and state ownership before adding registrations or process-wide state.

## Find existing abstractions first

- Start with the owning package's `package.json` exports, then inspect the relevant module and its tests. Exported subpaths are the public boundary; an exported declaration in an internal file is not automatically public API.
- Search by behavior as well as name across consumers before extracting anything. Prefer an existing mechanism, including Node or Pi APIs, over another wrapper.
- In `packages/pix-runtime`, look for cancellation, execution cleanup, process control, binary resolution, paths, safe writes, network deadlines, config, and agent-state coordination.
- In `packages/pix-pretty`, look for result construction, previews, framing, collapse presentation, batch output, modal paging, overlays, widgets, theme roles, and semantic icons.
- In `packages/pix-data`, look for model/provider metadata and pricing presentation.
- Compare contracts before merging similar code: bytes versus characters versus terminal columns; head versus tail; caller cancellation versus stopping the underlying job; display collapse versus retained content.
- When sharing a mechanism, remove matching local copies in the same change. Keep domain policy local rather than adding switches for unrelated behaviors.

## Pix contracts and traps

- Preserve user-selected models/providers and visible execution. Do not add silent routing, retries, delegation, or background automation.
- Collapsing a result changes presentation, not access to the full result. Reuse the shared tool surfaces, theme, and icon mechanisms instead of rebuilding their visual contract.
- Runtime owns path resolution, external-command resolution/execution, shared network deadlines, and config persistence. Feature packages should not bypass these with local implementations.
- Cancellation of a foreground caller does not imply termination of a shared daemon, remote operation, or established background job. Preserve the owner's stop and cleanup semantics.
- Use `bun run test`, not bare `bun test`: the root script enables isolation and the configured preload sandboxes user state. Reuse the shared config and renderer test fixtures.

## Feature package shape

- Follow the shape the feature packages already share: `main: src/index.ts`, one Pi entry (`src/index.ts`, or `src/extension.ts` re-exported as `./extension`), colocated `src/*.test.ts` with `*.render.test.ts` for UI, `README.md` and `LICENSE`. Tool cards use `tickCollapse` and pretty framing. Look at neighbouring packages before adding a new pattern.
- Import Pi only via `pix-runtime/host`, `pix-pretty/tui`, `pix-data/ai`; side-effect Node (`fs`, `child_process`, `net`, `crypto`, …) only via runtime. Lint enforces this.
- Platform-specific work goes through runtime: `exec` for processes, `binaries` for executables, `paths` for home/temp/project dirs, `atomic-write` for files. No `process.platform` branches.
- Wrap every entry in `once(pi, "<package dir>", …)`. `scripts/deps.test.ts` enforces it and the manifest shape.
- `runToolExecution` is optional. It reports an abort after success as a failure, so do not use it where a late cancel must keep a started job or result.

## Gates and deeper context

- Keep package versions independent. Minor/major bumps need user approval; an unpublished bump needs no second bump. Shared API changes must also account for consumer ranges and bundled dependencies.
- Before tagging, publishing, or changing release automation, read `docs/release.md`.
- For package loading and composition details, consult `docs/architecture.md`; verify API names and availability against current exports/source rather than treating documentation as a frozen catalog.
- For contribution and product-placement policy, read `.github/CONTRIBUTING.md`. Use the root scripts and Git hook implementation as the source of truth for checks; do not bypass failed checks.
