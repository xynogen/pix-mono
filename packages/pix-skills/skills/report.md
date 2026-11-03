---
name: report
description: Writes a detailed report that reads well in a terminal — verdict first, then numbered findings with severity, file:line, cause, impact, and fix, plus what was checked and what was not. Emoji only as a status marker beside a text label, never as decoration. Use when the user asks for a "report", "laporan", "status report", or "write up what we did".
disable-model-invocation: true
---
# Report

Goal: the reader sees the verdict at once, and gets enough detail on every real problem to act on it without asking again. The report reads well in an 80-column terminal.

## Steps

1. Collect facts from the conversation, code, and commands. Never report from memory. Re-run a check if its result may be stale.
2. For each finding, get the evidence: `file:line`, command output, or test name. Read the code around it so you can state the cause.
3. Print the report in chat, in the user's language. Size follows content: about 30–60 lines. Above 80 lines, give every finding in short form and offer "detail #N".

## Format

```markdown
**Verdict:** [emoji] [WORD] — [one sentence: state + what blocks done]

**Scope:** [what was checked: commits, packages, files, commands]

**Findings**

1. 🔴 [HIGH] [symptom, one line]
   Where:  `file:line`
   Cause:  [why it happens, one sentence]
   Impact: [what breaks, for whom, when]
   Fix:    [concrete change]

2. 🟡 [MED] [symptom]
   ...

**Checks:** ✅ [n] tests pass · ✅ lint · ❌ typecheck FAIL (`[error]`)
**Not checked:** [area] ([reason]), [area] ([reason])

**Next:**
1. [step] — [file or package]
2. [step] — [file or package]
```

## Rules

Readers scan first, then read the items they care about. Write for both.

1. **Front-load.** Put the verdict on line 1. Start each finding with its severity label and a one-line symptom. Put the detail on indented lines below it.
2. **Emoji as markers, not decoration.** The text label carries the meaning. The emoji is only a fast visual cue, because it renders differently per terminal and font.
   - Use only this set: 🔴 HIGH · 🟡 MED · 🔵 LOW · ✅ pass · ❌ FAIL · ⚠️ partial or warning.
   - Put it only at the start of a verdict, finding, or check item. Use at most one per line.
   - Always pair it with a text label: `🔴 [HIGH]`, `✅ 584 pass`, `❌ format FAIL`.
   - Never put emoji in prose, in `Cause:`/`Impact:`/`Fix:` lines, in headings, in tables, or in the `Next:` list.
   - Verdict words: `DONE`, `READY`, `READY WITH FIXES`, `BLOCKED`. Write the bad state in uppercase, so it stands out even when the emoji does not render.
3. **Order and number.** Sort findings by severity, then by impact. Number them, so the user can say "detail #2".
4. **Chunk.** Give at most 8 findings in full. List the rest as one line each under `**Minor (+N)**`.
5. **Evidence beside the claim.** Every finding has a `Where:` line with `file:line`, a command, or a test name. Quote the exact error string in backticks when there is one.
6. **Fit the terminal.** Keep lines to 80 characters or less. Do not use `#` headings. Indent finding detail by 3 spaces and align the field names. Put one blank line between findings and between sections.

**Language:** write in the user's language with STE100 rules (common words, short active sentences, one fact per sentence), in that language's own grammar. Keep standard English technical terms as-is (`race condition`, `signature resistance`, `passive PoE`). Never translate them literally. Keep code names, paths, versions, and errors exact. Field names (`Where`, `Cause`, `Impact`, `Fix`) may use the user's language.

## Content

- **Each finding has five parts:** symptom, location, cause, impact, and fix. If you do not know a part, write `(unverified)`. Never guess.
- **Fact or inference:** mark inference as `(likely)`. Mark claims you did not check as `(unverified)`.
- **Exact values:** keep exact numbers, paths, versions, status codes, and error strings.
- **Strengths:** give them on one `**Good:**` line with at most 3 items, and only when they affect the decision.
- **Not checked:** list what you did not check, with a reason (no access, no test, out of scope).
- **Next:** give ordered steps, each with the file or package it touches.
- **No filler:** no intro, no outro, and no restating the request.
- **Nothing broken:** write `**Findings:** none`, then say what you checked.
- **"detail #N":** expand only that item, with a code excerpt, the trace, and alternative fixes.

## Visual tools

Use one only when it is clearer than text.

| Data | Tool | Limit |
|---|---|---|
| Quality, fit, confidence | Stars `★★★☆☆` | Out of 5, next to an exact count |
| Same fields over 3+ items | Compact table | ≤ 4 columns, ≤ 80 chars, no sentences |
| Flow, layers, before/after | ASCII diagram | ≤ 8 lines, ≤ 70 chars, code block, mark the problem with `<-- #N` |

## Example

````markdown
**Verdict:** ⚠️ READY WITH FIXES — the intrusion feature (6 commits) works;
2 HIGH and 2 MED issues block prod.

**Scope:** commits a1b2c3..f6e7d8, `intrusion_*` modules, pytest, ruff.

**Findings**

1. 🔴 [HIGH] A worker can resolve another camera's event
   Where:  `intrusion_service.py:209`
   Cause:  `resolve()` filters by `event_id` only, not by `camera_id`.
   Impact: any worker can close any open alert; the audit log shows the
           wrong camera.
   Fix:    add `camera_id` to the WHERE clause; return 404 on a mismatch.

2. 🔴 [HIGH] Concurrent uploads overwrite MinIO evidence
   Where:  `intrusion_service.py:236`
   Cause:  the object key is `event_id.jpg`, with no lock and no version.
   Impact: the second upload replaces the first; the evidence is lost.
   Fix:    key by `event_id/<uuid>.jpg`, or enable bucket versioning.

3. 🟡 [MED] A second resolve returns 200, not 409
   Where:  `intrusion_repository.py:216`
   Cause:  the update does not check the current status.
   Impact: clients cannot detect a double resolve.
   Fix:    `WHERE status = 'open'`; return 409 when 0 rows match.

4. 🟡 [MED] Config upsert is not atomic; parallel PUT gives 500
   Where:  `intrusion_repository.py:59`
   Cause:  SELECT then INSERT, without `ON CONFLICT`.
   Impact: `UniqueViolation` under load (reproduced with 2 parallel PUTs).
   Fix:    `INSERT ... ON CONFLICT (camera_id) DO UPDATE`.

```
worker --> service --> PostgreSQL   pass (tx)
              \------> MinIO        same key, no lock  <-- #2
```

**Checks:** ✅ 584 tests pass · ✅ ruff · ❌ format FAIL (6 files)
**Not checked:** concurrency under load (no test), PG + MinIO together (no
staging access), monitoring and analytics (out of scope)
**Quality:** Design ★★★★☆ · Tests ★★☆☆☆ (no concurrency tests)

**Next:**
1. Fix #1 and #2 — `intrusion_service.py`
2. Add regression tests for #1–#4 — `tests/test_intrusion.py`
3. Run `ruff format` — 6 files
````
