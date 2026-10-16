---
name: cicd
description: Sets up a two-stage CI/CD release pipeline (validate on push/PR, publish on tag) for any language and most git-hosting platforms — GitHub Actions, Forgejo/Gitea Actions, GitLab CI. Use only on explicit request — "set up CI/CD", "add a release pipeline", "wire up publishing".
disable-model-invocation: true
---
# CI/CD release pipeline

Two stages, one invariant. **CI** validates every push/PR (fast) and can build+upload the artifact. **Publish** (on a version tag) re-runs the same CI, then downloads that exact artifact and ships it — never rebuilds.

**Golden rule: the artifact tested in CI is the exact artifact published.** Everything else is optimization around that invariant. Rebuilding at publish time voids it — the bytes you ship were never tested.

```text
push/PR   ──► ci        (lint · test:latest · build+upload artifact)
tag vX.Y  ──► publish ──┬─ ci (full: lint · test:full grid · build+upload)
                        └─ download artifact ─► auth ─► registry
```

Do not scaffold projects (`bootstrap`) or retrofit lint/type gates (`harden`) — this is only the release pipeline. It assumes a working test/gate command already exists; if not, stop and point at `harden`.

## 1. Detect (read-only)

- **Platform** — GitHub Actions (`.github/workflows/`), Forgejo/Gitea Actions (`.forgejo/workflows/` or `.gitea/workflows/`), GitLab CI (`.gitlab-ci.yml`), Woodpecker, Drone. This decides syntax and which security features exist (see matrix below).
- **Language + registry** — what gets published and where (npm, PyPI, crates.io, Maven Central, container registry, GitHub/Gitea Releases).
- **Existing gate** — the local command that lints+tests. CI must call this exact command, never a diverging copy.
- **Build + artifact naming** — the build command and the dist path/glob.
- **Verify, don't recall** — confirm action versions, registry auth, and CLI flags in the docs or with `--help`. If you cannot verify one, ask.

## 2. Propose

Present the plan before writing any workflow file: platform, the two files, publish trigger (tag vs release), auth mechanism (OIDC vs token — see matrix), and dependency-bot choice. Get approval. Publishing is irreversible; the pipeline that does it needs sign-off.

## 3. Apply

### 1. One callable CI file, matrix toggle

```yaml
on:
  workflow_call:                 # lets publish reuse this exact file
    inputs: { full: { type: boolean, default: false } }
  push: { branches: [main] }
  pull_request: { branches: [main] }
```

- Matrix widens under `full` — the cheap subset on push, the full support grid on release. The axis is whatever the project supports: language/runtime versions, OS, or toolchain versions.
  `matrix: { v: ${{ inputs.full && fromJSON('["a","b","c"]') || fromJSON('["c"]') }} }`
- `fail-fast: false` — one cell failing must not hide the others.
- **Lint in its own job**, once — it is version-independent, don't pay for it per matrix cell.
- **Build+upload job** runs the build, validates package metadata with the ecosystem's own check (`npm pack --dry-run`, `cargo package`, `twine check`, `mvn verify`, `goreleaser check` + `goreleaser release --snapshot`, `docker build`), and uploads the built artifact.

### 2. Publish reuses CI, downloads the artifact

```yaml
jobs:
  ci: { uses: ./<workflows-dir>/ci.yml, with: { full: true } }   # path per platform
  publish:
    needs: ci
    environment: release          # scopes trust + optional manual-approval gate
    permissions: { id-token: write }   # only where OIDC is used
    steps:
      - { uses: <download-artifact@SHA> }   # never a rebuild step here
      - { uses: <registry-publish@SHA> }
```

### 3. Harden every workflow

- **Least privilege** — top-level `permissions: {}`; grant per job (`contents: read`, and `id-token: write` only on publish).
- **`persist-credentials: false`** on checkout so no git token lingers on the runner.
- **Pin actions to a commit SHA** with a `# vX.Y.Z` comment — mutable tags (`@v5`) can be swapped under you. Resolve: `git ls-remote https://.../<action> refs/tags/vX.Y.Z`. (GitLab CI: pin images by `@sha256:` digest instead.)
- **Concurrency cancel on CI only** — `group: ci-${{ github.ref }}`, `cancel-in-progress: true`. **Never on publish** — do not interrupt a release mid-flight.

### 4. Auth to the registry

Prefer **OIDC / trusted publishing** where the platform+registry pair supports it — no long-lived token in secrets; the CI mints a short-lived one the registry trusts. Register the trusted publisher on the registry side once, out of band (owner/repo + workflow file + environment). Where OIDC is unavailable, fall back to a **scoped, expiring token** in the platform's secret store, granted only to the publish job/environment.

### 5. Keep pins fresh

A dependency bot rotates SHA pins so they don't rot, with a cooldown to skip brand-new (possibly compromised) releases. **This is the least portable piece** — pick by platform (matrix below).

## Platform compatibility matrix

| Concern | GitHub | Forgejo / Gitea Actions | GitLab CI |
|---|---|---|---|
| Workflow dir | `.github/workflows/` | `.forgejo/` or `.gitea/workflows/` | `.gitlab-ci.yml` |
| Syntax | Actions YAML | **Actions-compatible** (most `uses:` run) | GitLab pipeline YAML (different model) |
| Reusable CI | `workflow_call` | `workflow_call` (recent versions) | `include:` + `extends`/`!reference` |
| OIDC publish | yes, broad (PyPI, npm, ...) | limited; use a scoped token | yes (`id_tokens`) for supported registries |
| `permissions` / `id-token` | yes | yes (version-dependent) | via `id_tokens:` |
| Dependabot | yes | not supported | not supported (own scanners) |
| Dependency-bot fallback | Dependabot | **Renovate** (self-host or Mend; supports Gitea/Forgejo) | **Renovate**, or GitLab's dep scanning |
| Pin actions by SHA | yes | yes | pin images by `@sha256:` digest |

The shape (validate → tag → reuse CI → publish the tested artifact) is the same everywhere; only trigger syntax, auth, and the bot change. Forgejo/Gitea Actions runs most GitHub actions, but SHA-pinned third-party actions must be reachable from that instance's configured registry (often a GitHub mirror) — verify before relying on one.

## 4. Verify and report

- Ask before you push a branch to trigger CI. It must go green. Never push a release tag yourself; the user does that.
- Do a dry-run publish if the registry offers one (`npm publish --dry-run`, `cargo publish --dry-run`, TestPyPI, a staging registry) before a real tag.
- Confirm the publish job **downloads** the artifact and has no build step.
- Confirm CI runs the same gate command as local.

```text
## Pipeline: [project]
**Platform:** [GitHub/Forgejo/GitLab]
**CI:** [file] — push/PR fast, workflow_call full
**Publish:** [file] — trigger [tag/release], auth [OIDC/token], environment [name]
**Artifact:** built once in CI, downloaded at publish (no rebuild)
**Pins:** actions @SHA · deps via [Dependabot/Renovate]
```

## Stop if

- The publish job builds anything. It must download the CI artifact.
- Publish is not gated on a green CI run of the tagged commit.
