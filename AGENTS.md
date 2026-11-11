# Pix — Agent Guide

## Commands

- `bun run test`, not `bun test`: adds `--isolate`; the `bunfig.toml` preload sandboxes user state.
- `bun run typecheck`, not bare `tsc`: pix-mcp has its own tsconfigs.

## Rules

- Feature packages hold business logic only. Execution, resource lifecycle, paths, external commands, network deadlines and config belong in `pix-runtime`; UI and its lifecycle in `pix-pretty`; model metadata in `pix-data`. Do not reimplement these locally.
- Before adding a helper, search `pix-runtime`/`pix-pretty`/`pix-data` exports by behaviour. When sharing a mechanism, delete the local copies in the same change.
- Compare contracts before merging similar code: bytes vs characters vs terminal columns, head vs tail, caller cancel vs stopping the job, display collapse vs retained content.
- Pi reloads extension modules and drops module-local state. Check runtime state ownership before adding process-wide state.
- Match neighbouring feature packages: colocated `src/*.test.ts`, `*.render.test.ts` for UI, tool cards with `tickCollapse` and pretty framing.
- Platform-specific work goes through runtime: `exec`, `binaries`, `paths`, `atomic-write`.
- Preserve the user's model/provider choice and visible execution. No silent routing, retries, delegation or background automation.
- Collapse changes presentation only; the full result stays reachable.
- Cancelling a caller does not stop a shared daemon, remote operation or started background job.
- `runToolExecution` turns an abort after success into a failure. Do not use it where a late cancel must keep a started job or result.
- Minor/major bumps need user approval; an unpublished bump needs no second bump. Shared API changes must update consumer ranges.
- Never bypass the pre-commit hook (`--no-verify`).

## Read before

- Tagging, publishing, release automation → `docs/release.md`
- Package loading and composition → `docs/architecture.md` (check names against current exports)
- Contribution and product placement → `.github/CONTRIBUTING.md`
