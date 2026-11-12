---
name: pix-ask
description: How to use `ask_user` so it resolves a decision in one round — group the real questions, 2-4 concrete options each, multiSelect for item subsets, and no back-to-back asks. Use when a choice materially changes scope, cost, or safety, or when the user must pick among items.
disable-model-invocation: true
---
# ask_user — one structured decision

One call, up to 4 questions, each with 2-4 options. A free-text row is added automatically for single-select, so do not offer "Other".

## Input

```json
{ "questions": [
  { "header": "Release", "question": "Which bump for pix-edit?",
    "options": [ { "label": "Patch", "description": "0.2.18 → 0.2.19" },
                 { "label": "Minor", "description": "0.2.18 → 0.3.0" } ] }
] }
```

- `header` is a chip, max 16 characters. `question` ends with `?` and is specific.
- `label` max 60 characters, 1-5 words. `description` says what the option means or costs.
- `preview` (markdown) shows side-by-side; single-select only.
- `multiSelect: true` gives checkboxes and suppresses the free-text row. Use it whenever the user picks a subset of items, with one option per item.

## When to ask

Ask when a wrong guess is expensive to undo (schema, public API, architecture, deploy, deleting data), or when the intent is genuinely ambiguous. Make routine implementation decisions yourself.

## Do not

- Stack two `ask_user` calls back to back. Group every open question into one call.
- Bundle combinations ("All", "Only X", "Only the stopped ones") as single options when the real answer is "which of these items". Use `multiSelect`.
- Ask a question you could answer by reading the repo.
