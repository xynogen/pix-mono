---
name: ui
description: Designs, builds, redesigns, and reviews distinctive, usable, accessible interfaces across web, mobile, desktop, dashboards, and design systems. Use for any UI or UX work — new screens, components, layouts, styling, design reviews, or accessibility fixes.
disable-model-invocation: true
---
# UI/UX design

Create interfaces that are useful, coherent, distinctive, and production-ready. Treat visual design, interaction design, content, accessibility, responsiveness, and implementation quality as one system.

Do not optimize for novelty at the expense of usability. Do not optimize for familiarity until the result feels generic. Make every important choice traceable to the product, audience, task, and existing brand.

For a small change, apply only the relevant checks. For a new product or major redesign, follow the complete workflow.

## Core Principles

1. **Ground the design in the subject.** Understand the product's world, users, vocabulary, content, and constraints. Do not paste a fashionable style onto an unrelated product.
2. **Make the main task obvious.** A user should quickly understand where they are, what matters, and what they can do next.
3. **Choose a clear point of view.** Be decisive rather than automatically extreme. A regulated dashboard may need calm precision; a cultural launch may justify expressive maximalism.
4. **Create one signature.** Give the interface one memorable, product-specific idea. Spend boldness there and keep supporting elements disciplined.
5. **Use structure to communicate.** Layout, hierarchy, grouping, labels, dividers, and sequence must encode real meaning—not merely decorate.
6. **Preserve learned behavior.** Navigation and controls should be predictable unless a better interaction is demonstrably clearer.
7. **Design every state.** The interface is incomplete without loading, empty, error, success, disabled, selected, hover, focus, and offline states where relevant.
8. **Build a system, not a screenshot.** Use reusable components, semantic tokens, consistent rules, and responsive behavior.
9. **Accessibility is a quality floor.** It is not optional polish or a final pass.
10. **Verify the rendered result.** Code quality does not prove visual or interaction quality.

## Workflow

### 1. Understand and inspect

Before changing code:

- Define the **user**, their context, the problem, and the screen's single primary job.
- Identify primary and secondary actions, critical information, risks, and edge cases.
- Inspect the existing application before inventing a new visual language. Find its framework, components, tokens, fonts, icons, spacing, breakpoints, themes, and interaction patterns.
- Preserve the established system unless the request explicitly calls for a redesign. Extend existing primitives before adding competing ones.
- Use real product content when available. Do not let placeholder copy dictate the layout.
- Confirm relevant constraints: platform, browser/device support, performance, localization, input methods, brand, and accessibility target.
- Ask only when a missing decision would materially change the result; otherwise make and state a reasonable assumption.

### 2. Define the direction

For substantial work, form a compact design plan before coding:

- **Purpose:** What must this interface help the user accomplish?
- **Tone:** Choose 2–4 precise traits, such as clinical and calm, dense and technical, tactile and playful, or editorial and restrained.
- **Content hierarchy:** Identify the first, second, and third things the eye should notice.
- **Signature:** Name one memorable element rooted in the product's subject.
- **Tokens:** Define or reuse named values for color, type, spacing, radius, borders, elevation, and motion.
- **Layout:** Describe the spatial concept; use a small ASCII wireframe when structure is not obvious.
- **Interaction:** Describe navigation, feedback, state changes, and recovery from failure.

Critique the plan before implementation:

- Could the same concept be used unchanged for ten unrelated products?
- Is any choice present only because it is fashionable?
- Does the signature support the task or distract from it?
- Is visual hierarchy still clear without color or motion?
- Does the concept still work on the smallest supported screen?

Revise generic or unjustified choices before building.

### 3. Build

#### Information Architecture and Layout

- Put the primary task and essential context first. Use progressive disclosure for secondary complexity.
- Group related controls and content through proximity and alignment before adding containers.
- Use asymmetry, overlap, broken grids, or unusual composition only when they reinforce hierarchy or subject matter.
- Avoid card grids by default. A card must express a meaningful independent unit, not compensate for weak page structure.
- Support narrow and wide viewports without horizontal overflow. Reflow, collapse, scroll intentionally, or change interaction patterns rather than merely shrinking.
- Account for long text, localization, zoom, dynamic content, safe areas, virtual keyboards, and variable data.

#### Typography

- Typography carries both personality and hierarchy. Choose typefaces for a reason, not from habit.
- Preserve brand fonts when present. Common utility fonts are acceptable when density, readability, performance, or platform consistency justifies them; do not use them as an unexamined default.
- Define explicit display, heading, body, label, caption, and data roles as needed.
- Keep ordinary body text around 16px or larger where the platform permits, with comfortable line height and readable measure.
- Use weight, size, width, case, and spacing consistently. Avoid too many sizes or weights.
- Ensure tabular numbers, truncation, wrapping, and code/data typography behave correctly where relevant.

#### Color, Shape, and Depth

- Use semantic color roles such as background, surface, text, muted, border, accent, success, warning, and danger.
- Commit to a coherent palette with clear hierarchy. Do not distribute accent colors evenly or use raw framework colors without intent.
- Never rely on color alone to communicate state or meaning.
- Use radius, borders, shadows, gradients, blur, noise, and texture as a consistent material language—not a collection of effects.
- Flatness is valid when intentional. Texture is not mandatory; depth must clarify hierarchy or reinforce the concept.
- Verify light and dark themes independently rather than mechanically inverting colors.

#### Content and UX Writing

- Write from the user's perspective using words they recognize, not internal system terminology.
- Use specific nouns and active verbs. Controls should state their result: “Save changes,” not “Submit.”
- Keep action names consistent across buttons, dialogs, notifications, and documentation.
- Labels label; examples demonstrate; helper text explains. Do not make placeholders perform all three jobs.
- Errors must explain what happened and how to recover. Empty states should orient the user and offer a relevant next action.
- Avoid generic marketing filler, fake metrics, invented testimonials, and repetitive headings.

#### Interaction and Motion

- Every interactive element must look interactive and provide immediate feedback.
- Design for mouse, keyboard, touch, assistive technology, and device back behavior where applicable.
- Prefer direct manipulation and reversible actions. Confirm only destructive or costly operations; provide undo when practical.
- Use motion to explain causality, continuity, hierarchy, or system status. One orchestrated moment is usually stronger than many unrelated effects.
- Keep common transitions brief—often 150–300ms—and animate transform or opacity when possible.
- Avoid decorative motion that delays work, continuous distraction, layout-thrashing properties, and hover-only interactions.
- Respect `prefers-reduced-motion`; reduced motion must preserve meaning and functionality.

#### Forms and Feedback

- Use persistent visible labels, appropriate input types, autocomplete, clear requirements, and sensible defaults.
- Validate at a helpful time. Place a specific error next to the affected field and move focus appropriately after failed submission.
- Preserve user input after errors. Do not disable submission without explaining why.
- Distinguish loading, saving, saved, failed, and stale states. Prevent duplicate destructive or transactional actions.
- Use skeletons only when they reflect the final structure; otherwise prefer honest progress or status messaging.

#### Dashboards and Data

- Design for decisions, not decoration. Make the key question answerable at a glance, then support drill-down.
- Show units, time ranges, comparison baselines, data freshness, and definitions where ambiguity is possible.
- Choose charts by the relationship being communicated, not by visual novelty.
- Provide legends, labels, tooltips, accessible summaries, and non-color encodings.
- Tables need meaningful alignment, sorting/filter feedback, responsive behavior, empty states, and keyboard usability.
- Avoid meaningless hero metrics, misleading axes, excessive precision, and chart junk.

### 4. Production quality

- Use semantic platform primitives first: landmarks, headings, buttons, links, labels, lists, tables, and dialogs.
- Build modular components with clear responsibilities and all relevant variants and states.
- Use design tokens or shared variables instead of scattering raw hex values, spacing, radii, and timings through components.
- Follow the project's framework and styling conventions. Do not add a library when existing primitives are sufficient.
- Reserve media dimensions to prevent layout shift; optimize and lazy-load non-critical assets.
- Keep critical interactions responsive. Avoid unnecessary effects, oversized assets, hydration cost, and animation work.
- Use real icons from the existing icon system or intentional SVGs. Do not use emoji as generic interface icons.
- Do not remove browser affordances, disable zoom, hide focus rings, or replace semantic controls with inaccessible divs.

## Accessibility Requirements

Treat these as minimum checks, adjusted only when the target platform has stricter guidance:

- Normal text contrast is at least **4.5:1**; large text and meaningful graphics are at least **3:1**.
- Interactive targets are approximately **44×44 CSS px** on touch surfaces, with adequate separation.
- All functionality is keyboard reachable in a logical order, with visible focus and no keyboard traps.
- Icon-only controls have accessible names. Images have useful alternative text or are correctly marked decorative.
- Inputs have programmatic labels; errors and status changes are announced where needed.
- Dialogs manage focus, have an accessible name, close predictably, and restore focus.
- Headings and landmarks describe the page structure. DOM order remains sensible when visual order changes.
- Zoom, text resizing, long content, and 320px-wide reflow do not hide functionality.
- Motion can be reduced; flashing, autoplay, and time limits are avoided or controllable.
- Charts and status indicators provide text or shape/pattern alternatives to color.

## Verification and Iteration

Before delivery:

1. Run relevant diagnostics, type checks, tests, and builds.
2. Render the interface (browser automation or screenshot tool, if available) rather than judging source code alone. If you cannot render it, say so in the report.
3. Check representative narrow, medium, and wide viewports; include real device sizes when specified.
4. Exercise keyboard navigation, focus order, dialogs, forms, errors, loading, empty states, and destructive actions.
5. Check contrast, accessible names, semantics, reduced motion, overflow, text wrapping, and zoom.
6. Inspect screenshots for hierarchy, rhythm, alignment, density, clipping, inconsistency, and generic visual patterns.
7. Compare the result with the design plan and existing product system.
8. Remove one unnecessary decorative element, then fix the highest-impact remaining issue.
9. Repeat until the interface is both polished and usable.

## Anti-Patterns — Avoid Generic or Fragile UI

- Copy-paste hero sections, uniform card grids, and decorative bento layouts unrelated to content
- Habitual purple/blue gradients, glow effects, glass panels, giant text, or pill-shaped everything
- Choosing Inter, a serif/sans pairing, or any fashionable font combination without product-specific rationale
- Excessive rounded containers, shadows, gradients, texture, animation, badges, and floating elements
- Numbered sections where order has no meaning
- Generic copy, fake social proof, unexplained metrics, and placeholder-heavy layouts
- Tiny low-contrast text, hidden focus, hover-only controls, unlabeled icons, and color-only status
- Desktop layouts merely scaled down for mobile
- Raw values and one-off components that undermine the existing design system
- Beautiful happy-path screenshots with broken loading, error, empty, keyboard, or responsive states

## Definition of Done

The work is done only when:

- The primary task and hierarchy are immediately understandable.
- The design feels specific to its product and audience without harming usability.
- Content, interactions, and recovery states are complete.
- The implementation is responsive, accessible, performant, and consistent with the codebase.
- Components and tokens are reusable rather than page-specific hacks.
- The rendered interface has been inspected and refined across relevant states and viewport sizes.
