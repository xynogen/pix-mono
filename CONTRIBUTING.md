# Contributing to pix-mono

Thanks for your interest! Before opening a PR, please read this page — it
will save both of us time.

## This is an opinionated project

Pix was built for the maintainer's personal workflow and happens to be
open-source. Every visual choice — colors, layout, information density, single-line
footer — is **intentional**. The defaults are not arbitrary; they reflect a
specific terminal aesthetic and daily workflow.

### What this means for contributions

**Bug fixes are welcome.** If something is broken (crash, data loss, incorrect
behavior), open an issue or a PR. Regression tests are appreciated.

**Feature additions that extend capability are welcome.** New tools, skills,
and integrations are welcome when they add functionality Pix does not already
provide through a generic extension or configuration mechanism. Adding a named
provider to documentation, examples, defaults, or discovery surfaces does not
count as extending capability — see the placement policy below.

**Style and aesthetic PRs may be declined.** Changes to colors, spacing,
layout, wording, or visual presentation are at the sole discretion of the
maintainer. "I think this color should be different" or "this should be
configurable" is not a bug — it's a preference, and the maintainer's
preference wins. This includes but is not limited to:

- Color schemes and theming defaults
- Footer layout and segment ordering
- Tool output formatting and rendering
- Icon choices and typography
- Information density and truncation behavior

Some of these may become configurable in the future, but it's not a
priority right now. If it happens, it'll be on the maintainer's terms and
timeline — not driven by feature requests.

If you want a different visual style, **fork the project** — that's what
open source is for. The theme system (`pix-themes`) and config file
(`~/.pi/agent/pix.json`) already provide customization hooks for users who
want to tweak their own setup without changing upstream.

### Third-party product placement

Pix does not grant third-party products promotional placement merely because
they are compatible with the project. Because `.mcp.json` and the config file
already let any user wire up any server, SDK, or endpoint themselves, a change
that adds a *named* product to the project's own docs or defaults gives that
vendor distribution and placement while adding no capability Pix lacks. A good
product with a real, mutual benefit is a conversation worth having — start it
in an issue.

**Do not submit a PR containing any of the changes below without prior written
approval from the maintainer in a public issue.** Prior discussion or approval
permits review only; it does not create an expectation that the change will be
merged. PRs submitted without approval may be closed without review.

- Add or promote a named third-party product, service, server, endpoint, API,
  SDK, package, install command, link, badge, or account-creation flow in
  documentation, examples, templates, generated configuration, discovery
  results, setup flows, or defaults.
- Give a provider preferential visibility by presenting it as recommended,
  canonical, featured, preferred, easiest, or default, or by listing it more
  prominently than comparable alternatives.
- Add a vendor-specific direct or transitive dependency, wrapper, credential
  flow, analytics or telemetry hook, hosted-service dependency, or network
  route.

If the maintainer approves, the change must still meet both of these:

1. **Interest disclosed.** Disclose employment, contracting, sponsorship,
   investment, referral arrangements, maintainership, or any other financial
   or organizational relationship with the product or its operator. This
   requirement applies whether the offering is paid, free-tier, open source,
   or described as a community service. Material omission discovered after
   merge is grounds for revert, regardless of code quality.
2. **Opt-in and proportionate.** The change must not alter defaults, silently
   send data to a third party, require an account for existing functionality,
   or give one provider preferential placement. Adding nominal alternatives
   does not make promotional placement neutral.

Approval turns on two questions: does it make things genuinely better for
Pix's users — a real capability, not a worse option dressed up as choice — and
does Pix gain something concrete for carrying it (a capability it lacks, an
interoperability requirement, a maintenance win, or a fair partnership)?
Compatibility alone, convenience for one provider's customers, discoverability,
marketing value, or inclusion "only as an example" answers neither and is not
sufficient.

This policy applies to PRs, issues, discussions, generated content, and other
project-managed channels. Maintainers may close submissions, remove
promotional material, revert merged changes, or restrict participation for
repeated or deceptive promotion. It covers commercial, free-tier, hosted, and
vendor-backed open-source offerings alike. Pix's product promise is *no hidden
intent, no silent routing* — the same standard applies to the repository
itself.

### Platform support

**Linux is the primary platform.** macOS works and is tested occasionally.
Windows support is minimal — PRs that fix Windows-specific issues are
accepted when the fix doesn't complicate the Linux/macOS code path, but
Windows-only features or workarounds are low priority.

## Before you open a PR

1. **Run the full check suite:**

   ```bash
   bun run ci          # lint + format (biome)
   bun run typecheck   # tsc across all packages
   bun test            # all tests
   ```

2. **Add tests** for new behavior or bug fixes. Untested PRs will be asked
   for coverage before merge.

3. **Keep changes focused.** One logical change per PR. Don't bundle style
   tweaks with bug fixes.

4. **Bump the version** in `package.json` if your change affects a published
   package. The CI publish pipeline checks for version bumps automatically.

## Reporting issues

Open a GitHub issue. Include:

- What you expected vs what happened
- Steps to reproduce
- Terminal emulator + OS
- Pi version (`pi --version`) and pix-core version

## License

By contributing, you agree that your contributions will be licensed under
the project's MIT license.
