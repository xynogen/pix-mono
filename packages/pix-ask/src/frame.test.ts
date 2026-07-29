import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { frameLines, modalWidth } from "@xynogen/pix-pretty/modal-frame";

const noColor = (s: string) => s;

test("modalWidth prefers 40–96 columns without exceeding the render width", () => {
	expect(modalWidth(200)).toBe(96);
	expect(modalWidth(50)).toBe(46);
	expect(modalWidth(10)).toBe(10);
});

test("frameLines draws rounded border with uniform width", () => {
	const out = frameLines({
		width: 40,
		lines: ["hello", "world"],
		color: noColor,
	});
	const first = out[0] ?? "";
	const last = out[out.length - 1] ?? "";
	expect(first.startsWith("╭")).toBe(true);
	expect(first.endsWith("╮")).toBe(true);
	expect(last.startsWith("╰")).toBe(true);
	expect(last.endsWith("╯")).toBe(true);
	for (const line of out) {
		expect(visibleWidth(line)).toBe(40);
	}
});

test("frameLines pads ANSI-colored input by visible width", () => {
	const out = frameLines({
		width: 40,
		lines: ["\x1b[31mhi\x1b[0m"],
		color: noColor,
	});
	for (const line of out) {
		expect(visibleWidth(line)).toBe(40);
	}
});

test("frameLines wraps raw content in the base fg so unstyled text is colored", () => {
	// Mimics a pi-tui SelectList unselected label: raw text, no fg escape.
	const FG = "\x1b[38;5;7m";
	const FG_RESET = "\x1b[39m";
	const out = frameLines({
		width: 40,
		lines: ["No, block it"],
		color: noColor,
		fg: (s) => `${FG}${s}${FG_RESET}`,
	});
	const body = out[1] ?? "";
	// The raw label now carries an explicit foreground open sequence.
	expect(body).toContain(FG);
	expect(body).toContain("No, block it");
	// Width accounting is unchanged by the added escapes.
	expect(visibleWidth(body)).toBe(40);
});

test("frameLines re-asserts base fg after an embedded full reset", () => {
	const FG = "\x1b[38;5;7m";
	const out = frameLines({
		width: 40,
		// Selected label styled then reset, followed by an unstyled trailing label.
		lines: ["\x1b[36mselected\x1b[0m  plain"],
		color: noColor,
		bg: (s) => `\x1b[48;5;0m${s}\x1b[49m`,
		fg: (s) => `${FG}${s}\x1b[39m`,
	});
	const body = out[1] ?? "";
	// After the \x1b[0m reset, both bg and base fg opens are re-emitted so the
	// trailing "plain" text stays readable against the fill.
	expect(body).toContain("\x1b[0m\x1b[48;5;0m\x1b[38;5;7m");
	expect(visibleWidth(body)).toBe(40);
});
