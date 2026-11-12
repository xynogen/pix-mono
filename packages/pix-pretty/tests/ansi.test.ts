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
