import { expect, test } from "bun:test";
import { setKittyProtocolActive, visibleWidth } from "@earendil-works/pi-tui";
import {
	ensureVisibleOffset,
	fitModalLine,
	frameLines,
	frameModal,
	joinColumns,
	MIN_PERMISSION_MODAL_HEIGHT,
	type ModalFrameResult,
	ModalPager,
	modalBodyCapacity,
	modalHeight,
	modalWidth,
} from "./modal-frame.ts";

const plain = (text: string) => text;

function render(offset = 0): ModalFrameResult {
	return frameModal({
		width: 40,
		maxHeight: 10,
		header: ["title"],
		body: Array.from({ length: 12 }, (_, index) => `body ${index + 1}`),
		footer: ["divider", "Allow", "Deny", "help"],
		bodyOffset: offset,
		color: plain,
	});
}

test("modalHeight resolves configured percentages and rows without exceeding the terminal", () => {
	expect(modalHeight(40)).toBe(32);
	expect(modalHeight(40, "50%")).toBe(20);
	expect(modalHeight(40, 12)).toBe(12);
	expect(modalHeight(10)).toBe(8);
	expect(modalHeight(1)).toBe(1);
});

test("frameLines embeds a title in the top border at exact width", () => {
	const out = frameLines({ width: 40, title: "pix settings", lines: ["body"], color: plain });
	expect(out[0]).toContain("╭─ pix settings ");
	expect(out[0]!.endsWith("╮")).toBe(true);
	// Every row (title border included) is exactly `width` visible cells.
	for (const line of out) expect(visibleWidth(line)).toBe(40);
});

test("frameLines truncates an over-long title but keeps the border width", () => {
	const out = frameLines({
		width: 30,
		title: "a very long title that will not fit",
		lines: ["x"],
		color: plain,
	});
	expect(visibleWidth(out[0]!)).toBe(30);
	expect(out[0]).toContain("…");
});

test("frameLines falls back to a plain border when too narrow for a title", () => {
	const out = frameLines({ width: 6, title: "hello", lines: ["x"], color: plain });
	// No room for "─ h… ─" chrome — plain border, still exact width.
	expect(out[0]).not.toContain("hello");
	expect(visibleWidth(out[0]!)).toBe(6);
});

test("frameLines without a title is unchanged (bare top border)", () => {
	const out = frameLines({ width: 20, lines: ["x"], color: plain });
	expect(out[0]).toBe("╭──────────────────╮");
});

test("joinColumns aligns left cells to leftWidth by visible width, ignoring ANSI", () => {
	const left = ["\x1b[31mab\x1b[0m", "longer"];
	const right = ["X", "Y"];
	const rows = joinColumns(left, right, { leftWidth: 6, rightWidth: 4, gap: 2 });
	// Row 0: styled "ab" (visible width 2) padded to 6 + 2-space gap + "X".
	expect(visibleWidth(rows[0]!)).toBe(6 + 2 + 1);
	expect(rows[0]).toContain("\x1b[31mab\x1b[0m");
});

test("joinColumns pads the shorter column with blank rows", () => {
	const rows = joinColumns(["a", "b", "c"], ["x"], { leftWidth: 3, rightWidth: 3 });
	expect(rows.length).toBe(3);
	// Later rows still render the left cell + gap, right side empty.
	expect(rows[2]!.startsWith("c")).toBe(true);
});

test("joinColumns uses a styled separator when given, over gap spaces", () => {
	const rows = joinColumns(["a"], ["b"], { leftWidth: 2, rightWidth: 2, sep: " | " });
	expect(rows[0]).toContain(" | ");
});

test("joinColumns truncates over-wide cells to their column width", () => {
	const rows = joinColumns(["abcdef"], ["uvwxyz"], { leftWidth: 3, rightWidth: 3, gap: 1 });
	expect(visibleWidth(rows[0]!)).toBe(3 + 1 + 3);
});

test("modalHeight is defensive about junk row counts", () => {
	expect(modalHeight(Number.NaN)).toBe(19); // falls back to 24 rows
	expect(modalHeight(Number.POSITIVE_INFINITY)).toBe(19);
	expect(modalHeight(0)).toBe(1);
	expect(modalHeight(-5)).toBe(1);
	expect(modalHeight(40, "100%")).toBe(40);
});

test("modalWidth resolves configured percentages and columns without exceeding available width", () => {
	expect(modalWidth(200)).toBe(200);
	expect(modalWidth(200, "50%")).toBe(100);
	expect(modalWidth(200, 88)).toBe(88);
	expect(modalWidth(50)).toBe(50);
	expect(modalWidth(10)).toBe(10);
	expect(modalWidth(1)).toBe(1);
});

test("fitModalLine distinguishes lossless wrapping from irreversible truncation", () => {
	const long = "A".repeat(300);
	const wrapped = fitModalLine(long, 20);
	expect(wrapped.truncated).toBe(false);
	expect(wrapped.rows.length).toBeGreaterThan(1);
	expect(wrapped.rows.every((line) => visibleWidth(line) <= 20)).toBe(true);

	const cut = fitModalLine(long, 20, false);
	expect(cut.truncated).toBe(true);
	expect(cut.rows).toHaveLength(1);
	expect(cut.rows[0]).toContain("…");
});

test("frameLines uses an unframed fallback when border chrome cannot fit", () => {
	for (const width of [1, 2, 3]) {
		const lines = frameLines({ width, lines: ["content"], color: plain });
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width);
	}
});

function pagerWithViewport(): ModalPager {
	const pager = new ModalPager();
	pager.sync({
		lines: [],
		bodyOffset: 0,
		maxBodyOffset: 12,
		visibleBodyLines: 6,
		bodyOverflowed: true,
		textTruncated: false,
		pinnedRowsFit: true,
	});
	const pageDown = "\x1b[6~";
	const pageUp = "\x1b[5~";
	// Half-page scroll: step = floor(6/2) = 3
	expect(pager.handleInput(pageDown)).toBe(true);
	expect(pager.bodyOffset).toBe(3);
	expect(pager.handleInput(pageDown)).toBe(true);
	expect(pager.bodyOffset).toBe(6);
	expect(pager.handleInput(pageDown)).toBe(true);
	expect(pager.bodyOffset).toBe(9);
	expect(pager.handleInput(pageDown)).toBe(true);
	expect(pager.bodyOffset).toBe(12);
	expect(pager.handleInput(pageDown)).toBe(false);
	expect(pager.handleInput(pageUp)).toBe(true);
	expect(pager.bodyOffset).toBe(9);
	return pager;
}

test("ModalPager handles legacy PageUp/PageDown through pi-tui", () => {
	pagerWithViewport();
});

test("ModalPager handles Kitty functional PageUp/PageDown through pi-tui", () => {
	setKittyProtocolActive(true);
	try {
		const pager = new ModalPager();
		pager.sync({
			lines: [],
			bodyOffset: 0,
			maxBodyOffset: 12,
			visibleBodyLines: 6,
			bodyOverflowed: true,
			textTruncated: false,
			pinnedRowsFit: true,
		});
		// Kitty functional key codepoints from pi-tui's own key table.
		// Half-page scroll: step = floor(6/2) = 3
		expect(pager.handleInput("\x1b[57422u")).toBe(true);
		expect(pager.bodyOffset).toBe(3);
		expect(pager.handleInput("\x1b[57421u")).toBe(true);
		expect(pager.bodyOffset).toBe(0);
	} finally {
		setKittyProtocolActive(false);
	}
});

test("ModalPager accepts arrow left/right as page up/down when arrowPages is true", () => {
	const pager = new ModalPager();
	pager.sync({
		lines: [],
		bodyOffset: 0,
		maxBodyOffset: 12,
		visibleBodyLines: 6,
		bodyOverflowed: true,
		textTruncated: false,
		pinnedRowsFit: true,
	});
	const arrowRight = "\x1b[C";
	const arrowLeft = "\x1b[D";
	// Without arrowPages, arrows are ignored
	expect(pager.handleInput(arrowRight)).toBe(false);
	expect(pager.bodyOffset).toBe(0);
	// With arrowPages enabled — half-page scroll: step = floor(6/2) = 3
	expect(pager.handleInput(arrowRight, undefined, true)).toBe(true);
	expect(pager.bodyOffset).toBe(3);
	expect(pager.handleInput(arrowLeft, undefined, true)).toBe(true);
	expect(pager.bodyOffset).toBe(0);
});

test("ModalPager arrow paging works under Kitty protocol", () => {
	setKittyProtocolActive(true);
	try {
		const pager = new ModalPager();
		pager.sync({
			lines: [],
			bodyOffset: 0,
			maxBodyOffset: 10,
			visibleBodyLines: 6,
			bodyOverflowed: true,
			textTruncated: false,
			pinnedRowsFit: true,
		});
		const arrowRight = "\x1b[C";
		const arrowLeft = "\x1b[D";
		// Half-page scroll: step = floor(6/2) = 3
		expect(pager.handleInput(arrowRight, undefined, true)).toBe(true);
		expect(pager.bodyOffset).toBe(3);
		expect(pager.handleInput(arrowLeft, undefined, true)).toBe(true);
		expect(pager.bodyOffset).toBe(0);
	} finally {
		setKittyProtocolActive(false);
	}
});

test("modalBodyCapacity subtracts borders and pinned rows", () => {
	expect(modalBodyCapacity(16, 6)).toBe(8);
	expect(modalBodyCapacity(10, 20)).toBe(0);
});

test("ensureVisibleOffset keeps a selected rendered-row range in view", () => {
	expect(ensureVisibleOffset(0, 5, 20, 0, 2)).toBe(0);
	expect(ensureVisibleOffset(0, 5, 20, 7, 9)).toBe(4);
	expect(ensureVisibleOffset(10, 5, 20, 7, 9)).toBe(7);
	expect(ensureVisibleOffset(99, 5, 20, 19, 20)).toBe(15);
	expect(ensureVisibleOffset(0, 0, 20, 7, 9)).toBe(0);
});

test("frameModal stays within maxHeight and pins footer controls", () => {
	const result = render();
	expect(result.lines).toHaveLength(10);
	expect(result.lines.join("\n")).toContain("title");
	expect(result.lines.join("\n")).toContain("Allow");
	expect(result.lines.join("\n")).toContain("Deny");
	expect(result.lines.join("\n")).toContain("help");
	expect(result.maxBodyOffset).toBeGreaterThan(0);
	expect(result.bodyOverflowed).toBe(true);
	expect(result.textTruncated).toBe(false);
	for (const line of result.lines) expect(visibleWidth(line)).toBe(40);
});

test("frameModal reports intentional fixed-row truncation separately from paging", () => {
	const result = frameModal({
		width: 40,
		maxHeight: 10,
		body: ["X".repeat(100)],
		wrap: false,
		color: plain,
	});
	expect(result.textTruncated).toBe(true);
	expect(result.lines.join("\n")).toContain("…");
});

test("frameModal wraps long text before applying the height budget", () => {
	const result = frameModal({
		width: 40,
		maxHeight: 8,
		body: ["command ".repeat(60)],
		color: plain,
	});
	expect(result.bodyOverflowed).toBe(true);
	expect(result.textTruncated).toBe(false);
	expect(result.lines.length).toBeLessThanOrEqual(8);
});

test("frameModal pages the body without losing pinned rows", () => {
	const first = render(0);
	const last = render(first.maxBodyOffset);
	expect(first.lines.join("\n")).toContain("body 1");
	expect(first.lines.join("\n")).not.toContain("body 12");
	expect(last.lines.join("\n")).toContain("body 12");
	expect(last.lines.join("\n")).toContain("Allow");
	expect(last.bodyOffset).toBe(last.maxBodyOffset);
});

test("frameModal clamps an out-of-range bodyOffset", () => {
	const high = render(9999);
	expect(high.bodyOffset).toBe(high.maxBodyOffset);
	const low = frameModal({
		width: 40,
		maxHeight: 10,
		body: ["a", "b"],
		bodyOffset: -20,
		color: plain,
	});
	expect(low.bodyOffset).toBe(0);
});

test("frameModal reports hidden rows via the overflow indicator", () => {
	const seen: string[] = [];
	frameModal({
		width: 40,
		maxHeight: 10,
		header: ["title"],
		body: Array.from({ length: 12 }, (_, i) => `body ${i + 1}`),
		footer: ["divider", "Allow", "Deny", "help"],
		color: plain,
		overflowLine: (state) => {
			seen.push(`${state.start}-${state.end}/${state.total}+${state.hiddenAfter}`);
			return "overflow";
		},
	});
	expect(seen).toEqual(["0-2/12+10"]);
});

test("frameModal overflow page number reaches totalPages on last page", () => {
	const pages: string[] = [];
	const body = Array.from({ length: 20 }, (_, i) => `line ${i}`);
	// maxHeight=12: 2 border + 1 header + 1 footer + 1 overflow = 5 chrome → 7 visible body
	// maxBodyOffset = 20-7 = 13, step = floor(7/2) = 3
	// totalPages = ceil(13/3)+1 = 5+1 = 6 (but actually ceil(13/3)=5, +1=6)
	// Half-page offsets: 0, 3, 6, 9, 12, 13(max)
	const offsets = [0, 3, 6, 9, 12, 13];
	for (const offset of offsets) {
		frameModal({
			width: 40,
			maxHeight: 12,
			header: ["title"],
			body,
			footer: ["help"],
			bodyOffset: offset,
			color: plain,
			overflowLine: (state) => {
				pages.push(`${state.page}/${state.totalPages}`);
				return `page ${state.page}/${state.totalPages}`;
			},
		});
	}
	// page must reach totalPages at maxBodyOffset
	expect(pages[pages.length - 1]).toMatch(/^\d+\/\d+$/);
	const last = pages[pages.length - 1]!.split("/");
	expect(last[0]).toBe(last[1]); // last page == totalPages
	// pages must be monotonically non-decreasing
	const nums = pages.map((p) => Number(p.split("/")[0]));
	for (let i = 1; i < nums.length; i++) {
		expect(nums[i]).toBeGreaterThanOrEqual(nums[i - 1]!);
	}
});

test("frameModal omits the overflow row when everything fits", () => {
	const result = frameModal({
		width: 40,
		maxHeight: 12,
		header: ["title"],
		body: ["only"],
		footer: ["help"],
		color: plain,
	});
	expect(result.lines.join("\n")).not.toContain("PageUp/PageDown");
	expect(result.maxBodyOffset).toBe(0);
	expect(result.pinnedRowsFit).toBe(true);
});

test("frameModal honors an explicit fail-closed minimum height", () => {
	const result = frameModal({
		width: 40,
		maxHeight: MIN_PERMISSION_MODAL_HEIGHT - 1,
		minHeight: MIN_PERMISSION_MODAL_HEIGHT,
		header: ["DANGEROUS"],
		body: ["command"],
		footer: ["Allow", "Deny"],
		color: plain,
	});
	expect(result.pinnedRowsFit).toBe(false);
	expect(result.lines.join("\n")).toContain("Terminal too short");
	expect(result.lines.join("\n")).not.toContain("Allow");
});

test("frameModal reports when pinned rows cannot fit", () => {
	const result = frameModal({
		width: 40,
		maxHeight: 5,
		header: ["title"],
		body: ["command"],
		footer: ["one", "two", "three"],
		color: plain,
	});
	expect(result.pinnedRowsFit).toBe(false);
	expect(result.lines.length).toBeLessThanOrEqual(5);
	// Fail-closed frame keeps its borders and offers no approval control.
	expect(result.lines.at(0)).toContain("╭");
	expect(result.lines.at(-1)).toContain("╰");
	expect(result.lines.join("\n")).toContain("Terminal too short");
	expect(result.lines.join("\n")).not.toContain("two");
});

test("frameModal uses an unframed fail-closed diagnostic below border capacity", () => {
	for (const maxHeight of [1, 2]) {
		const result = frameModal({
			width: 20,
			maxHeight,
			header: ["DANGEROUS"],
			body: ["command"],
			footer: ["Allow", "Deny"],
			color: plain,
		});
		expect(result.pinnedRowsFit).toBe(false);
		expect(result.lines.length).toBeLessThanOrEqual(maxHeight);
		expect(result.lines.join("\n")).not.toContain("Allow");
		for (const line of result.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
	}
});

test("frameModal fails closed when overflow cannot fit an indicator and body row", () => {
	const result = frameModal({
		width: 40,
		maxHeight: 8,
		header: ["title"],
		body: Array.from({ length: 40 }, (_, i) => `row ${i}`),
		footer: ["divider", "Allow", "Deny", "help"],
		color: plain,
	});
	expect(result.pinnedRowsFit).toBe(false);
	expect(result.lines.length).toBeLessThanOrEqual(8);
	expect(result.lines.join("\n")).not.toContain("Allow");
});

test("frameModal never exceeds maxHeight across a range of budgets", () => {
	for (const maxHeight of [1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32]) {
		const result = frameModal({
			width: 40,
			maxHeight,
			header: ["title"],
			body: Array.from({ length: 40 }, (_, i) => `row ${i}`),
			footer: ["divider", "Allow", "Deny", "help"],
			color: plain,
		});
		expect(result.lines.length).toBeLessThanOrEqual(maxHeight);
		for (const line of result.lines) expect(visibleWidth(line)).toBe(40);
	}
});

test("a permission-shaped modal fits its controls at MIN_PERMISSION_MODAL_HEIGHT", () => {
	// divider + countdown + 2 choices + blank + help = 6 pinned footer rows.
	const footer = ["divider", "auto-deny in 5s", "Allow", "Deny", "", "help"];
	const result = frameModal({
		width: 40,
		maxHeight: MIN_PERMISSION_MODAL_HEIGHT,
		header: ["DANGEROUS"],
		body: Array.from({ length: 30 }, (_, i) => `arg-${i}`),
		footer,
		color: plain,
	});
	expect(result.pinnedRowsFit).toBe(true);
	expect(result.lines.length).toBeLessThanOrEqual(MIN_PERMISSION_MODAL_HEIGHT);
	expect(result.lines.join("\n")).toContain("Allow");
	expect(result.lines.join("\n")).toContain("Deny");
	expect(result.visibleBodyLines).toBeGreaterThanOrEqual(1);
});

test("frameModal delegates styling to frameLines (ANSI width + bg reassertion)", () => {
	const result = frameModal({
		width: 30,
		maxHeight: 8,
		header: ["\x1b[1mbold title\x1b[0m"],
		body: ["plain body"],
		footer: ["help"],
		color: (s) => `\x1b[36m${s}\x1b[39m`,
		bg: (s) => `\x1b[44m${s}\x1b[49m`,
		fg: (s) => `\x1b[37m${s}\x1b[39m`,
	});
	for (const line of result.lines) expect(visibleWidth(line)).toBe(30);
	// The embedded \x1b[0m from the bold header must not punch a hole in the bg.
	const header = result.lines[1] as string;
	expect(header).toContain("\x1b[0m\x1b[44m");
});

test("frameModal supports a pinned top row and still respects maxHeight", () => {
	const result = frameModal({
		width: 40,
		maxHeight: 8,
		top: "tab bar",
		header: ["title"],
		body: Array.from({ length: 20 }, (_, i) => `row ${i}`),
		footer: ["help"],
		color: plain,
	});
	expect(result.lines.length).toBeLessThanOrEqual(8);
	expect(result.lines.join("\n")).toContain("tab bar");
	expect(result.lines.join("\n")).toContain("help");
});
