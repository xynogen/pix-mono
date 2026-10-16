---
name: brainstorm
description: Explores and refines a design before any code is written — clarifies goals, compares 2-3 approaches, and gets the design approved section by section. Use when the user wants to design, spec, or think through a new feature, system, or project, or says "let's brainstorm" or "how should we build X".
disable-model-invocation: true
---
# Brainstorm

**Hard gate:** write no code, scaffold nothing, and take no implementation action until the user approves a design. This applies to every request, however simple it looks.

## Steps

1. **Explore** — Read the existing files, docs, and recent commits. Know what exists before you propose anything.
2. **Clarify** — Use `ask_user` for purpose, constraints, success criteria, and edge cases. Group up to 4 related questions per call. Prefer options to open questions. Continue until the scope is clear.
3. **Propose 2-3 approaches** — Show distinct options with their trade-offs. Lead with your recommendation and say why. Cut every feature the goal does not need (YAGNI).
4. **Present the design** — Scale the sections to the complexity: architecture, components, data flow, error handling, testing. Get approval after each section. Revise as needed.
5. **Write it down** — Save the approved design to `docs/plans/YYYY-MM-DD-<topic>-design.md`. Offer to commit it. Do not commit without a request.
6. **Hand off** — The next step is `/plan` → "+ New plan" for the implementation plan. Do not start coding from here.
