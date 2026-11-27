import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent } from "@xynogen/pix-pretty/tui";
import { renderDisplayMarkdown } from "../src/directives.ts";
import { foldHeaders, followFoldInput, initFolds, renderFolds } from "../src/fold.ts";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const plain = (text: string) => text.replace(ANSI_RE, "");
const doc = "Intro\n::fold[CI log]\nline 1\nline 2\n::fold\nAfter";

describe("renderFolds", () => {
	it("collapses a section to one summary line", () => {
		expect(plain(renderFolds(doc, false))).toBe(
			"Intro\n\n▸ CI log · 2 lines (click or ctrl+o to expand)\n\nAfter",
		);
	});

	it("shows the whole section with a header when expanded", () => {
		expect(plain(renderFolds(doc, true))).toBe("Intro\n\n▾ CI log\n\nline 1\nline 2\n\nAfter");
	});

	it("runs an unclosed fold to the end while streaming", () => {
		expect(plain(renderFolds("::fold\na\nb", false))).toBe(
			"\n▸ Folded · 2 lines (click or ctrl+o to expand)\n",
		);
	});

	it("keeps a marker inside a code fence literal", () => {
		const text = "```\n::fold[x]\n```";
		expect(renderFolds(text, false)).toBe(text);
	});
});

describe("foldHeaders", () => {
	it("maps each header row to its fold, in order", () => {
		const texts = ["::fold[A]\na\n::fold\n::fold[B]\nb\n::fold"];
		const lines = ["", "▸ A · 1 lines", "", "▸ B · 1 lines", ""];
		expect(foldHeaders(lines, texts)).toEqual([
			{ row: 1, key: "A\na" },
			{ row: 3, key: "B\nb" },
		]);
	});
});

describe("fold clicks", () => {
	beforeAll(() => {
		initTheme("dark");
		followFoldInput();
		initFolds({ getToolsExpanded: () => false, theme: { fg: (_color, text) => text } });
	});

	const message = (text: string) =>
		new AssistantMessageComponent(
			{ role: "assistant", content: [{ type: "text", text }] } as never,
			false,
			undefined,
			undefined,
			0,
			[(markdown, { availableWidth }) => renderDisplayMarkdown(markdown, availableWidth)],
		);
	const linesOf = (c: AssistantMessageComponent) =>
		c
			.render(40)
			.map(plain)
			.map((l) => l.trimEnd());
	// `handled` only: the dispatch target the type adds is not under test.
	const click = (c: AssistantMessageComponent, y: number) =>
		c.handleMouse({
			type: "click",
			button: "left",
			x: 2,
			y,
			width: 40,
			height: 30,
			screenX: 2,
			screenY: y,
			shift: false,
			alt: false,
			ctrl: false,
		})?.handled;
	const row = (c: AssistantMessageComponent, text: string) =>
		linesOf(c).findIndex((l) => l.includes(text));

	it("a click in an open fold's body closes it; text outside a fold does nothing", () => {
		const c = message(
			"Top\n::fold[A]\nalpha 1\n\nalpha 2\n::fold\nMid\n::fold[B]\nbeta\n::fold\nEnd",
		);
		expect(click(c, row(c, "▸ A"))).toBe(true);
		expect(linesOf(c)).toContain("alpha 2");
		// The blank row inside the body counts as well.
		expect(click(c, row(c, "alpha 1") + 1)).toBe(true);
		expect(linesOf(c)).not.toContain("alpha 2");
		expect(click(c, row(c, "▸ A"))).toBe(true);
		expect(click(c, row(c, "Mid"))).toBeUndefined();
		expect(click(c, row(c, "Top"))).toBeUndefined();
		expect(click(c, row(c, "alpha 2"))).toBe(true);
		expect(linesOf(c).some((l) => l.startsWith("▸ A"))).toBe(true);
		// A closed fold's body is not on screen: the row below its header is outside.
		expect(click(c, row(c, "▸ B") + 1)).toBeUndefined();
	});
});
