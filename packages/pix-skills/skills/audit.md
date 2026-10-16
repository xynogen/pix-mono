---
name: audit
description: Security and health audit of a repository — leaked secrets, injection and unsafe input, broken references, vulnerable or unused dependencies — with file:line evidence and severity. Use only on explicit request such as "audit this", "security scan", "check for secrets", "is this safe", or "find vulnerabilities".
disable-model-invocation: true
---
# Audit

Every finding needs `file:line` evidence and a fix. No vague warnings.

## Scan

If the target is unclear (whole repo, one package, one diff), ask once.

- **Secrets** — Search with the grep tool for API keys, tokens, `password=`, private keys, and connection strings. Search git history only when asked: `git log -p -S'<pattern>'`, or `gitleaks` if it is installed.
- **Inputs** — Trace untrusted input to sinks: SQL, shell, file paths, deserialization, HTML.
- **Integrity** — Imports resolve, symlinks are valid, cross-module references hold.
- **Dependencies** — Known CVEs and outdated packages via the installed tool (`npm audit`, `bun audit`, `pip-audit`, `cargo audit`, `govulncheck`). If none is installed, report "not checked". Do not install one without consent.
- **Bloat** — Unused dependencies, dead files, duplicate logic.

## Severity

- **Critical** — exposed secret, remote code execution, injection (untrusted input reaches a sink with no validation), auth bypass.
- **Warning** — dependency with a known CVE, weak crypto, missing validation that does not reach a sink.
- **Info** — dead code, hardening opportunity, style risk.

## Report

```
## Audit findings — [scope]

### Critical
- **[Issue]** — `file:line`
  Evidence: [exact snippet]
  Fix: [step]

### Warning
- **[Issue]** — `file:line` · Fix: [step]

### Info
- **[Issue]** — `file:line` · Note: [context]

## Summary
[N critical, N warning, N info. Scanned: [what]. Not checked: [what]. Fix first: [item].]
```

## Rules

- Never claim "no issues" without listing what you scanned.
- Never rewrite git history to remove a secret without explicit confirmation. Recommend rotating the key first.
- More than about 15 findings in one severity: show the top ones and state how many you left out.
