<!-- markdownlint-disable MD013 MD040 MD060 -->

# pix-mono — CI / CD and Publish Runbook

Moved out of `AGENTS.md`. Read it before you tag, publish, or change CI.

## 12. CI / CD

**CI** runs on every push to `main` and on PRs: `bun run static-analysis` (biome ci → tsc → deps → package smoke → audit) → `bun run test` → coverage ratchet. It runs on `ubuntu-latest` only.

**CD** starts on a release tag push (`release-YYYYMMDD-HHMM`), never on a direct branch push.

```bash
# Bump version(s), commit, push to main, wait for CI green, then:
TAG="release-$(date +%Y%m%d-%H%M)" && git tag "$TAG" && git push origin "$TAG"
```

The Publish workflow triggers **on the tag push itself** (`on: push: tags: release-[0-9]*`). Its first step polls the Actions API and **requires a green CI run on that exact commit** before it publishes. It does not re-run the suite. A tag pushed while CI still runs waits (up to ~10 min) instead of failing. A failed/cancelled CI aborts the publish. It then checks each `name@version` against npm and publishes only new versions (idempotent, OIDC trusted publishing, no NPM_TOKEN). Dry-run locally: `bun run publish:dry`.

Because the tag is the trigger, there is **no tag-push race** and no manual dispatch. `workflow_dispatch` stays only as a break-glass fallback that publishes from the `main` tip (still gated on that commit's CI being green).

### 12.1 Agent runbook — "publish"

"publish" (alone) means: run this exact sequence. Do not ask again which packages.

1. **Approve once, up front** — inspect the release scope, then use `ask_user` once. The approval prompt must show:
   - current branch and target commit SHA;
   - dirty files and proposed commit message, or state that no commit is needed;
   - commits included since the previous release tag;
   - exact package/version list planned for npm;
   - target release tag (`release-YYYYMMDD-HHMM`);
   - remote effects: commit push if needed, push to `main`, tag push, Publish workflow trigger, and npm publication.

   Approval covers the complete listed release. Do not ask again unless the target commit, tag, or package/version list changes after approval.
2. **Gate** — `bun run check && bun run typecheck && bun run test`. Red → STOP.
3. **Confirm bumps** — changed packages must have a version ahead of npm. An unbumped package silently ships nothing (no error).
4. **Dry-run** — `bun run publish:dry`. Note the exact `name@version` list. If it differs from the approved list, STOP and request new approval.
5. **Push commits + wait for CI** — push to `main`, then `gh run watch <ci-run-id> --exit-status` for the branch CI on the pushed SHA. CI must be green *before* tagging. Red → STOP.
6. **Tag + push** — create and push the release tag without another approval. This triggers the Publish workflow directly. The Publish job confirms CI is green on the tagged commit, then publishes.
7. **Verify GitHub Actions** — find the Publish run (`gh run list --workflow Publish --limit 1`) and `gh run watch <run-id> --exit-status`. Confirm its log reports every expected `name@version` as published and ends with `0 failed`. Report the Publish workflow URL and exact published versions. Red → STOP and report the failing step/log. Never claim the release succeeded from the tag push alone. If the tag push fails to trigger Publish, the fallback is `gh workflow run Publish --ref main`.

