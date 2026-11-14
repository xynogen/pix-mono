import { describe, expect, it } from "bun:test";
import { rgbColor, styleText, Text, type TextStyle, visibleWidth } from "@earendil-works/pi-tui";
import { MAX_PREVIEW_LINES } from "../src/config.ts";
import { getIconMode, icon, iconFor, setIconMode } from "../src/icon-catalog.ts";
import {
	clickToggle,
	dotJoin,
	hideCollapsedToolCall,
	padIcon,
	renderCall,
	renderCollapsed,
	renderDimPreview,
	renderRow,
	renderTitle,
	widgetActivityRow,
	widgetTitle,
} from "../src/render-row.ts";
import type { FgTheme } from "../src/types.ts";

class MockTextComponent {
	private text = "";
	invalidations = 0;

	setText(value: string): void {
		this.text = value;
	}

	render(): string[] {
		return this.text.split("\n");
	}

	invalidate(): void {
		this.invalidations++;
	}
}

// Counting variant: records how often the inner component is re-fitted, so a
// regression that recomputes every frame (the pre-memo CPU bug) fails loudly.

const ANSI = /\x1b\[[0-9;]*m/g;

function plain(text: string): string {
	return text.replace(ANSI, "");
}

const theme: FgTheme = { fg: (_key, text) => text };

it("collapsed status marks follow live icon mode changes", () => {
	const previous = getIconMode();
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	try {
		for (const mode of ["ascii", "nerd", "unicode"] as const) {
			setIconMode(mode);
			for (const [status, key] of [
				["success", "status.ok"],
				["error", "status.error"],
				["warning", "status.warn"],
			] as const) {
				expect(renderRow(theme, "graph", "query", "done", status)).toStartWith(padIcon(icon(key)));
			}
		}
	} finally {
		setIconMode(previous);
	}
});

describe("tool call lifecycle", () => {
	it("uses pending, running, success, and error markers in order", () => {
		const theme = {
			fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
			bold: (text: string) => text,
		};
		for (const [context, role, key] of [
			[{ executionStarted: false, isPartial: true }, "muted", "status.pending"],
			[{ executionStarted: true, isPartial: true }, "warning", "status.running"],
			[{ executionStarted: true, isPartial: false }, "success", "status.ok"],
			[{ executionStarted: true, isPartial: false, isError: true }, "error", "status.error"],
		] as const) {
			expect(renderTitle(theme, "edit", context)).toBe(
				`<${role}>${padIcon(icon(key))}</${role}> <toolTitle>edit</toolTitle>`,
			);
		}
	});
	it("separates tool and action with a dot without empty-action spacing", () => {
		const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>` };
		for (const [tool, action] of [
			["proc", "start"],
			["download", "pause"],
			["graph", "query"],
			["ssh", "info"],
		] as const) {
			expect(renderTitle(theme, tool, {}, action)).toContain(
				`<toolTitle>${tool} · ${action}</toolTitle>`,
			);
		}
		expect(renderTitle(theme, "proc", {}, "")).toBe(renderTitle(theme, "proc"));
	});
});

describe("renderCall", () => {
	it("reuses text, follows lifecycle, and restores collapsed calls when expanded", () => {
		const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>` };
		const previous = new MockTextComponent();
		const context = {
			lastComponent: previous,
			state: { collapsed: false },
			expanded: false,
			executionStarted: true,
			isPartial: true,
		};
		const render = renderCall<{ action?: string; target?: string }>(
			"download",
			(args) => args.target ?? "",
			(args) => args.action,
		);
		const args = { action: "pause", target: "dl-1" };
		expect(render(args, theme, context)).toBe(previous);
		expect(previous.render().join("\n")).toBe(
			`${renderTitle(theme, "download", context, "pause")} <dim>dl-1</dim>`,
		);
		context.state.collapsed = true;
		render(args, theme, context);
		expect(previous.render().join("\n")).toBe("");
		context.expanded = true;
		context.isPartial = false;
		render(args, theme, context);
		expect(previous.render().join("\n")).toContain(
			`<success>${padIcon(icon("status.ok"))}</success>`,
		);
		render({}, theme, context);
		expect(previous.render().join("\n")).toBe(renderTitle(theme, "download", context));
	});

	it("creates a component when the host has no reusable text", () => {
		const theme = { fg: (_role: string, text: string) => text };
		const render = renderCall(
			"todo",
			() => "",
			(args) => String(args.action ?? ""),
		);
		const component = render({ action: "list" }, theme, { state: {}, expanded: false });
		expect(component.render(80).join("\n")).toContain("todo · list");
	});
});

describe("dotJoin", () => {
	it("joins non-empty parts with a middot, dropping falsy pieces", () => {
		expect(dotJoin(["a", "b", "c"])).toBe("a · b · c");
		expect(dotJoin(["a", "", null, undefined, false, "b"])).toBe("a · b");
		expect(dotJoin(["only"])).toBe("only");
		expect(dotJoin([])).toBe("");
	});

	it("paints the separator when a paint fn is supplied", () => {
		expect(dotJoin(["a", "b"], (s) => `<${s}>`)).toBe("a< · >b");
	});
});

// Minimal theme: fg() passes text through untouched.

describe("collapsed tool rows", () => {
	const rowTheme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };

	it("uses dim for the target and muted for tertiary metadata", () => {
		const taggedTheme = {
			fg: (key: string, text: string) => `<${key}>${text}</${key}>`,
			bold: (text: string) => text,
		};
		expect(renderRow(taggedTheme, "read", "src/a.ts", "12 lines", "success", 1000)).toContain(
			"<dim>src/a.ts</dim> <muted>·</muted> <muted>12 lines</muted>",
		);
	});

	it("renders a consistent status, tool, target, and metadata row", () => {
		// The status marker is width-normalized to 2 cells (padIcon) so wide glyphs
		// align with narrow ones; a 1-cell `✓` therefore carries one pad space.
		expect(renderRow(rowTheme, "read", "src/a.ts", "12 lines")).toBe("✓  read src/a.ts · 12 lines");
		const rendered = plain(renderCollapsed(rowTheme, "read", "src/a.ts", "12 lines"));
		expect(rendered).toStartWith("✓  read src/a.ts · 12 lines");
	});

	it("fades overflowing Unicode targets while retaining status and trailing metadata", () => {
		const fadeTheme = {
			fg: (_key: string, text: string) => text,
			bold: (text: string) => text,
			colors: { dim: rgbColor(180, 180, 180), customMessageBg: rgbColor(20, 20, 20) },
			style: (text: string, style: TextStyle) => styleText(text, style, "truecolor"),
		};
		for (const width of [35, 60, 90]) {
			const row = renderRow(
				fadeTheme,
				"todo",
				"界e\u0301🙂".repeat(60),
				"1/3 done",
				"warning",
				width,
			);
			expect(plain(row)).toMatch(/^⚠\s+todo .* · 1\/3 done$/);
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			expect(row).toContain("\x1b[38;2;20;20;20m");
		}
		for (let width = 0; width < 35; width++) {
			expect(
				visibleWidth(renderRow(fadeTheme, "todo", "long task", "1/3 done", "error", width)),
			).toBeLessThanOrEqual(width);
		}
	});

	it("keeps activity prefixes intact and clips overflow with theme-safe fallback", () => {
		const theme = { fg: (_role: string, text: string) => text };
		expect(widgetActivityRow(theme, "Agent [GPT] · 2s", "reading", 80)).toBe(
			"Agent [GPT] · 2s · reading",
		);
		for (let width = 0; width < 80; width++) {
			expect(
				visibleWidth(widgetActivityRow(theme, "Agent [GPT] · 2s", "界e\u0301🙂".repeat(30), width)),
			).toBeLessThanOrEqual(width);
		}
		expect(widgetActivityRow(theme, "Agent · 2s", "", 80)).toBe("Agent · 2s");
	});

	it("anchors stats to the right independently of middle activity length", () => {
		const theme = { fg: (_role: string, text: string) => text };
		for (const width of [40, 60, 100]) {
			for (const activity of ["", "Short", "界e\u0301🙂".repeat(40)]) {
				const row = widgetActivityRow(theme, "Agent [GPT]", activity, width, "2 tools · 3.5s");
				expect(row).toMatch(/^Agent \[GPT\].* {2,}2 tools · 3\.5s$/);
				expect(visibleWidth(row)).toBe(width);
			}
		}
		for (let width = 0; width < 40; width++) {
			expect(
				visibleWidth(
					widgetActivityRow(theme, "Agent [GPT]", "long ".repeat(40), width, "2 tools · 3.5s"),
				),
			).toBeLessThanOrEqual(width);
		}
	});

	it("aligns widget dividers across all icon modes", () => {
		const theme = { fg: (_role: string, text: string) => text };
		for (const mode of ["nerd", "unicode", "ascii"] as const) {
			const titles = [
				widgetTitle(theme, iconFor("lsp", mode), "LSP"),
				widgetTitle(theme, iconFor("status.ok", mode), "Todo"),
				widgetTitle(theme, iconFor("agent", mode), "Agents"),
				widgetTitle(theme, iconFor("agent", mode), "BTW"),
				widgetTitle(theme, iconFor("update", mode), "Download"),
				widgetTitle(theme, iconFor("process", mode), "Proc"),
				widgetTitle(theme, "", ""),
			];
			for (const title of titles) {
				expect(visibleWidth(title.split("│")[0]!)).toBe(13);
				expect(title).toEndWith(" │ ");
			}
		}
	});

	it("padIcon normalizes markers to a fixed cell width (per pi-tui visibleWidth)", () => {
		// pi-tui's width table drives the actual TUI column math, so padIcon trusts
		// it: `✓`/`✗`/`⚠` measure 1 cell and gain a pad space; `⚡` measures 2 and
		// is left as-is. All markers then occupy the same 2-cell column.
		expect(padIcon("✓")).toBe("✓ ");
		expect(padIcon("✗")).toBe("✗ ");
		expect(padIcon("⚠")).toBe("⚠ ");
		expect(padIcon("⚡")).toBe("⚡"); // already 2 cells — unchanged
		expect(padIcon("x", 4)).toBe("x   "); // explicit width
		expect(padIcon("⚡", 1)).toBe("⚡"); // never truncated below its own width
	});

	it("hides only collapsed, non-expanded call rows", () => {
		let value = "unchanged";
		expect(hideCollapsedToolCall({ collapsed: true }, false, (text) => (value = text))).toBe(true);
		expect(value).toBe("");
		expect(hideCollapsedToolCall({ collapsed: true }, true, () => {})).toBe(false);
	});
});

describe("renderDimPreview", () => {
	it("renders 'done' for empty input", () => {
		expect(plain(renderDimPreview("", theme))).toContain("done");
	});

	it("shows every line when under the cap", () => {
		const out = plain(renderDimPreview("a\nb\nc", theme));
		expect(out).toContain("a");
		expect(out).toContain("b");
		expect(out).toContain("c");
		expect(out).not.toContain("more line");
	});

	it("does not add overflow marker at exactly the cap", () => {
		const body = Array.from({ length: MAX_PREVIEW_LINES }, (_, i) => `L${i}`);
		const out = plain(renderDimPreview(body.join("\n"), theme));
		expect(out).not.toContain("more line");
	});

	it("adds singular overflow marker for 1 extra line", () => {
		const body = Array.from({ length: MAX_PREVIEW_LINES + 1 }, (_, i) => `L${i}`);
		const out = plain(renderDimPreview(body.join("\n"), theme));
		expect(out).toContain("… 1 more line");
		expect(out).not.toContain("more lines");
	});

	it("adds plural overflow marker for many extra lines", () => {
		const body = Array.from({ length: MAX_PREVIEW_LINES + 3 }, (_, i) => `L${i}`);
		const out = plain(renderDimPreview(body.join("\n"), theme));
		expect(out).toContain("… 3 more lines");
	});

	it("respects a custom maxLines", () => {
		const out = plain(renderDimPreview("a\nb\nc\nd", theme, { maxLines: 2 }));
		expect(out).toContain("… 2 more lines");
	});

	it("prepends a header line when given", () => {
		const out = plain(renderDimPreview("body", theme, { header: "5 matches" }));
		expect(out).toContain("5 matches");
		expect(out).toContain("body");
	});

	it("keeps the body first and adds one solid close", () => {
		const lines = plain(renderDimPreview("a\nb", theme, { frame: true, header: "2 files" })).split(
			"\n",
		);
		expect(lines.slice(0, -1).map((line) => line.trimEnd())).toEqual(["	a", "	b"]);
		expect(lines.at(-1)).toMatch(/^─{3,}$/);
	});

	it("paints the solid close when a paint fn is given", () => {
		const tag: FgTheme = { fg: (k, v) => `<${k}>${v}` };
		const lines = renderDimPreview("a\nb", tag, {
			frame: true,
			paint: (s: string) => tag.fg("success", s),
		}).split("\n");
		expect(plain(lines.at(-1) ?? "")).toMatch(/^<success>─{3,}/);
	});

	it("puts overflow metadata below the solid close", () => {
		const body = Array.from({ length: MAX_PREVIEW_LINES + 2 }, (_, i) => `L${i}`);
		const lines = plain(renderDimPreview(body.join("\n"), theme, { frame: true })).split("\n");
		expect(lines.at(-2)).toMatch(/^─{3,}$/);
		expect(lines.at(-1)).toContain("… 2 more lines");
	});

	it("highlights matched keyword with non-dim styling", () => {
		const raw = renderDimPreview("foo bar foo", theme, { highlight: "foo" });
		// matched 'foo' wrapped in yellow/bold ANSI (not produced by stub fg)
		expect(raw).toContain("\x1b[");
		expect(plain(raw)).toContain("foo bar foo");
	});

	it("treats regex metacharacters as literal highlight text", () => {
		const raw = renderDimPreview("call(foo)", theme, { highlight: "(" });
		expect(plain(raw)).toContain("call(foo)");
		expect(raw).toContain("\x1b[");
	});

	it("highlights every regex match, not just a literal substring", () => {
		// /te.t/ must light up both 'test' and 'text' — a literal indexOf can't.
		const raw = renderDimPreview("test text", theme, { highlight: /te.t/g });
		// Two bold-open codes = two highlighted hits.
		expect(raw.split("\x1b[1m").length - 1).toBe(2);
		expect(plain(raw)).toContain("test text");
	});

	it("does not loop on a zero-width regex match", () => {
		// /x*/ matches empty everywhere — must terminate and keep content intact.
		const raw = renderDimPreview("abc", theme, { highlight: /x*/g });
		expect(plain(raw)).toContain("abc");
	});

	it("skips highlighting a line that already carries ANSI (no escape corruption)", () => {
		// Pre-colored input: a match inside an escape would corrupt it, so the
		// whole line is dimmed instead — no BOLD hit is injected.
		const preColored = "\x1b[31mtest\x1b[0m done";
		const raw = renderDimPreview(preColored, theme, { highlight: "test" });
		expect(raw).not.toContain("\x1b[1m"); // no bold hit
		expect(raw).toContain("\x1b[31m"); // original ANSI preserved
	});

	it("renders an === label === separator as a section divider", () => {
		const raw = renderDimPreview("=== branch ===\nmain", theme, {});
		// Label survives; the raw === markers are gone (replaced by a rule).
		expect(plain(raw)).toContain("branch");
		expect(plain(raw)).not.toContain("===");
		expect(plain(raw)).toContain("─"); // divider glyph
		expect(plain(raw)).toContain("main"); // ordinary lines untouched
	});
});

describe("clickToggle", () => {
	it("left click rebuilds with the flipped state; other events stay unhandled", () => {
		const card = clickToggle(false, (open) => new Text(open ? "head\nbody" : "head", 0, 0));
		const click = (button: string, type = "click") =>
			card.handleMouse({ type, button, x: 0, y: 0 } as never);

		expect(card.render(40)).toHaveLength(1);
		expect(click("right")).toBeUndefined();
		expect(click("left", "press")).toBeUndefined();
		expect(card.render(40)).toHaveLength(1);
		expect(click("left")).toEqual({ handled: true });
		expect(card.render(40)).toHaveLength(2);
		click("left");
		expect(card.render(40)).toHaveLength(1);
	});
});
