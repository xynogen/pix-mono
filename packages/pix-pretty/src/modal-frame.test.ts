import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	ensureVisibleOffset,
	frameLines,
	frameModal,
	MIN_PERMISSION_MODAL_HEIGHT,
	type ModalFrameResult,
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

test("modalHeight uses 80% without exceeding the terminal", () => {
	expect(modalHeight(40)).toBe(32);
	expect(modalHeight(10)).toBe(8);
	expect(modalHeight(1)).toBe(1);
});

test("modalHeight is defensive about junk row counts", () => {
	expect(modalHeight(Number.NaN)).toBe(19); // falls back to 24 rows
	expect(modalHeight(Number.POSITIVE_INFINITY)).toBe(19);
	expect(modalHeight(0)).toBe(1);
	expect(modalHeight(-5)).toBe(1);
	expect(modalHeight(40, 100)).toBe(40);
});

test("modalWidth never exceeds the available render width", () => {
	expect(modalWidth(200)).toBe(96);
	expect(modalWidth(50)).toBe(46);
	expect(modalWidth(10)).toBe(10);
	expect(modalWidth(1)).toBe(1);
});

test("frameLines uses an unframed fallback when border chrome cannot fit", () => {
	for (const width of [1, 2, 3]) {
		const lines = frameLines({ width, lines: ["content"], color: plain });
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width);
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
	for (const line of result.lines) expect(visibleWidth(line)).toBe(40);
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
