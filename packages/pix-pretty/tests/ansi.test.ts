import { describe, expect, test } from "bun:test";
import * as ansi from "../src/ansi.ts";
import { resolveBaseBackground } from "../src/ansi.ts";

describe("tool surfaces", () => {
	test("always preserves terminal background", () => {
		resolveBaseBackground({ getBgAnsi: () => "\x1b[48;2;10;20;30m" });
		expect(ansi.BG_BASE).toBe("\x1b[49m");
		expect(ansi.BG_ERROR).toBe("\x1b[49m");
		expect(ansi.RST).toBe("\x1b[0m");
	});
});

describe("reopenAfterResets", () => {
	const BG = "\x1b[48;2;1;2;3m";
	test("re-opens the background after full and background resets", () => {
		expect(ansi.reopenAfterResets("a\x1b[0mb\x1b[49mc\x1b[mx", BG)).toBe(
			`a\x1b[0m${BG}b\x1b[49m${BG}c\x1b[m${BG}x`,
		);
	});
	test("leaves color arguments and foreground resets alone without fgOpen", () => {
		const s = "\x1b[38;2;49;0;0mx\x1b[48;5;49my\x1b[39m";
		expect(ansi.reopenAfterResets(s, BG)).toBe(s);
	});
	test("solidBackground keeps the card color behind embedded resets", () => {
		const bg = ansi.solidBackground((t) => `${BG}${t}\x1b[49m`);
		expect(bg("a\x1b[0mb")).toBe(`${BG}a\x1b[0m${BG}b\x1b[49m`);
	});
});
