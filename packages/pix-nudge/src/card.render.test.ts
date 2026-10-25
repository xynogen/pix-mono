import { expect, test } from "bun:test";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import { CAPABILITY_MESSAGE, NUDGE_ENTRY, nudgeCard, registerNudgeRenderers } from "./card.ts";

const card = {
	kind: "tool",
	summary: "bash read → read",
	body: "Reading a file via bash cat/head/tail/sed -n. Use `read` (offset/limit pick lines) instead.",
};

test("nudge card is one warning row collapsed and adds the full text when expanded", async () => {
	const fixture = await withUiFixture();
	try {
		const theme = roleTheme() as never;
		const collapsed = captureRows(nudgeCard(card, false, theme), {
			width: 80,
			surface: "component",
		});
		const expanded = captureRows(nudgeCard(card, true, theme), { width: 80, surface: "component" });

		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toMatch(
			/^<accent>\S+\s*<\/accent> <toolTitle\+bold>nudge<\/toolTitle\+bold> <dim>bash read → read<\/dim> <muted>·<\/muted> <muted>tool<\/muted>/,
		);
		expect(expanded[0]).toBe(collapsed[0]);
		// Body rows use pix-pretty's bodyLine indent (BODY_PAD tab), wrapped rows included.
		expect(expanded.slice(1)).toEqual([
			expect.stringMatching(/^\t<dim>Reading a file .*<\/dim>$/),
			expect.stringMatching(/^\t<dim>.*instead\.<\/dim>$/),
		]);
	} finally {
		await fixture.restore();
	}
});

test("entry and capability message share the card renderer", async () => {
	const fixture = await withUiFixture();
	try {
		const renderers: Record<string, (item: never, opts: never, theme: never) => unknown> = {};
		registerNudgeRenderers({
			registerEntryRenderer: (type: string, fn: never) => {
				renderers[type] = fn;
			},
			registerMessageRenderer: (type: string, fn: never) => {
				renderers[type] = fn;
			},
		} as never);
		const theme = roleTheme() as never;
		const rows = (c: unknown) =>
			captureRows(c as { render(w: number): string[] }, { width: 80, surface: "component" });

		const entry = rows(
			renderers[NUDGE_ENTRY]?.({ data: card } as never, { expanded: false } as never, theme),
		);
		const message = rows(
			renderers[CAPABILITY_MESSAGE]?.(
				{
					content: "Toolbelt: 3 tools.\n(Orientation only — not a task.)",
					details: { kind: "orientation", summary: "3 tools" },
				} as never,
				{ expanded: false } as never,
				theme,
			),
		);
		const messageOpen = rows(
			renderers[CAPABILITY_MESSAGE]?.(
				{ content: "Toolbelt: 3 tools.\n(Orientation only — not a task.)" } as never,
				{ expanded: true } as never,
				theme,
			),
		);

		expect(entry).toHaveLength(1);
		expect(message).toEqual([expect.stringMatching(/nudge.*<dim>3 tools<\/dim>.*orientation/)]);
		// No details (older session) → first content line becomes the summary; body stays expandable.
		expect(messageOpen[0]).toMatch(/<dim>Toolbelt: 3 tools\.<\/dim>/);
		expect(messageOpen.at(-1)).toMatch(/Orientation only/);
	} finally {
		await fixture.restore();
	}
});
