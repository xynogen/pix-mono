# Pix — Agent Guide

## Commands

- `bun run test`, not `bun test`: adds `--isolate`; the `bunfig.toml` preload sandboxes user state. One package: `bun test --isolate packages/<pkg>`.
- `bun run typecheck`, not bare `tsc`: pix-mcp has its own tsconfigs.
- CI gates: `bun run static-analysis` (biome, typecheck, dependency/shape checks, tarball smoke, audit) and `bun scripts/coverage-ratchet.ts`. There is no pre-commit hook; run both before a commit.

## Rules

- Feature packages hold business logic only. Execution, resource lifecycle, paths, external commands, network deadlines and config belong in `pix-runtime`; UI and its lifecycle in `pix-pretty`; model metadata in `pix-data`. Do not reimplement these locally.
- Before adding a helper, search `pix-runtime`/`pix-pretty`/`pix-data` exports by behaviour. When sharing a mechanism, delete the local copies in the same change.
- Compare contracts before merging similar code: bytes vs characters vs terminal columns, head vs tail, caller cancel vs stopping the job, display collapse vs retained content.
- Pi reloads extension modules and drops module-local state. Check runtime state ownership before adding process-wide state.
- Match neighbouring feature packages: tool cards with `tickCollapse` and pretty framing; wiring in `index.ts`/`extension.ts`, rendering in `render.ts`, results/actions in their own module, pure logic in `lib.ts`. Pass closure state explicitly.
- Function size is ratcheted: `complexity.noExcessiveLinesPerFunction` in `biome.json`. After a split, lower `maxLines` to the new largest function; never raise it.
- Tests live in `packages/<pkg>/tests/`, mirroring `src/` (`src/tools/x.ts` → `tests/tools/x.test.ts`), with `*.render.test.ts` for UI and `__snapshots__/` beside them. Never add tests, fixtures or snapshots to `src/` (`scripts/deps.test.ts` fails); `files` publishes `src` whole. Shared test helpers other packages import stay exported from `src/` (`@xynogen/pix-pretty/test-utils`).
- `pix-runtime/src/host.ts` holds named re-exports of Pi only. Runtime helpers get their own module and export (`output.ts` `truncateOutput`, `io.ts` `ioTimeoutSignal`).
- Shared renderers keep cards consistent: file content uses `renderFileContent` (numbered gutter, as in read/write/edit); shell output uses `outputBodyRows`. A cut preview fades content only, never gutters, rules or tree connectors.
- No `as unknown as` or `as never` to silence types; fix the type. A necessary cast carries a `// SAFETY:` reason.
- Platform-specific work goes through runtime: `exec`, `binaries`, `paths`, `atomic-write`.
- Preserve the user's model/provider choice and visible execution. No silent routing, retries, delegation or background automation.
- Collapse changes presentation only; the full result stays reachable.
- Cancelling a caller does not stop a shared daemon, remote operation or started background job.
- `runToolExecution` turns an abort after success into a failure. Do not use it where a late cancel must keep a started job or result.
- Minor/major bumps need user approval; an unpublished bump needs no second bump. Shared API changes must update consumer ranges.

## Read before

- Tagging, publishing, release automation → `docs/release.md`
- Package loading and composition → `docs/architecture.md` (check names against current exports)
- Contribution and product placement → `.github/CONTRIBUTING.md`
