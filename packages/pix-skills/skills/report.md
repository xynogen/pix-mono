---
name: report
description: Writes a short visual report that reads well in a terminal — verdict first, grouped one-line findings with file:line, star ratings, compact tables, small ASCII diagrams — with no wall of text. Use when the user asks for a "report", "laporan", "status report", or "write up what we did".
disable-model-invocation: true
---
# Report

Goal: the reader sees the verdict and every real problem at a glance, in an 80-column terminal.

## Steps

1. Collect facts from the conversation, code, and commands. Never report from memory.
2. Print the report in chat, in the user's language. Target 20 lines; never exceed 35.

## Format

```markdown
**Verdict:** [status emoji] [one sentence: state + what blocks done]

**🔴 High**
- [symptom] — `file:line`

**🟡 Medium**
- [symptom] — `file:line`

[optional: star ratings, compact table, or ASCII diagram]

**Tests:** ✅ [n] pass · ✅ lint · ⚠️ [problem]
**Untested:** [area], [area], [area]

**Next:** [step] → [step] → [step]
```

## Rules

Readers scan. They do not read every word. Write for the scan.

1. **Front-load.** Put the verdict on line 1. Start each line with its key word or number. Readers look most at the top and at the start of lines.
2. **Chunk.** Use at most 4 groups and at most 5 items in a group. Show the top 5 and add `+N more`. People keep about 4 items in mind at one time.
3. **Signal only what matters.** Use bold only for labels. When everything has a mark, nothing stands out.
4. **One mark per meaning.** Show severity with one emoji: ✅ ❌ ⚠️ 🔴 🟡 🟢. Put a text label next to it. People read emoji differently.
5. **Evidence beside the claim.** Put `file:line` on the same line as the symptom. Do not state a fact two times. The eye must not jump.
6. **Bars for judgments.** Show quality with stars out of 5: `Tests ★★☆☆☆`. People read length faster than words. Keep exact counts as numbers.
7. **Fit the terminal.** Keep lines to 80 characters or less. Do not use `#` headings or nested bullets. Put one blank line between groups.

**Language:** write in the user's language with STE100 rules (common words, short active sentences, one fact per sentence), in that language's own grammar. Keep standard English technical terms as-is (`signature resistance`, `passive PoE`, `race condition`); never translate them literally. Keep code names, paths, and errors exact.

## Visual tools

Use one only when it beats a bullet.

| Data | Tool | Limit |
|---|---|---|
| Quality, fit, confidence | Stars `★★★☆☆` | Out of 5 |
| Same fields over 3+ items | Compact table | ≤ 4 columns, ≤ 80 chars, no sentences |
| Flow, layers, before/after | ASCII diagram | ≤ 8 lines, ≤ 70 chars, code block, mark the problem |

## Content

- One line per finding: symptom, then `file:line`. No cause or fix advice in it.
- No paragraphs, no intro, no outro. Strengths go in a star rating, not a list.
- Keep exact numbers, paths, status codes, names. Cut everything else.
- Mark unchecked facts `(unverified)`. Never invent results.
- Drop empty groups. If nothing is broken, write `**Fix:** ✅ none`.
- The user asks for more on one item ("detail #1") → explain only that item.

## Example

````markdown
**Verdict:** ⚠️ Intrusion feature (6 commits) is sound; 4 fixes before prod.

**🔴 High**
- Worker can resolve another camera's event — `intrusion_service.py:209`
- Concurrent uploads overwrite MinIO evidence — `intrusion_service.py:236`

**🟡 Medium**
- Re-resolve returns 200, not 409 — `intrusion_repository.py:216`
- Config upsert not atomic; parallel PUT → 500 — `intrusion_repository.py:59`

```
worker ─▶ service ─▶ PostgreSQL  ✅ tx
             └──────▶ MinIO       🔴 same key, no lock
```

**Quality:** Design ★★★★☆ · Tests ★★☆☆☆ · Consistency ★★★☆☆
**Tests:** ✅ 584 pass · ✅ ruff · ⚠️ 6 files unformatted
**Untested:** monitoring, analytics, roles, concurrency, PG + MinIO

**Next:** fix 🔴 → regression tests → align types with height/thermal
````
