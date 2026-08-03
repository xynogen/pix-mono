import { describe, expect, it } from "bun:test";
import { buildOptHelp, levelBar } from "./opt.ts";
import type { OptimizerHandle, OptimizerTool } from "./status.ts";

/** Build a handle set with fixed current values + value lists. */
function fakeHandles(): Record<OptimizerTool, OptimizerHandle> {
	const mk = (name: OptimizerTool, current: string, values: string[]): OptimizerHandle => ({
		name,
		help: `${name} — ${name} help`,
		values,
		current: () => current,
		run: () => {},
	});
	return {
		caveman: mk("caveman", "full", ["off", "lite", "full", "ultra", "micro"]),
		rtk: mk("rtk", "on", ["off", "on"]),
		ponytail: mk("ponytail", "off", ["off", "lite", "full", "ultra"]),
	};
}

describe("levelBar", () => {
	const PONYTAIL = ["off", "lite", "full", "ultra"];
	const BINARY = ["off", "on"];

	it("fills segments by value position in a multi-step ladder", () => {
		expect(levelBar("off", PONYTAIL)).toBe("▱▱▱");
		expect(levelBar("lite", PONYTAIL)).toBe("▰▱▱");
		expect(levelBar("full", PONYTAIL)).toBe("▰▰▱");
		expect(levelBar("ultra", PONYTAIL)).toBe("▰▰▰");
	});

	it("renders a single segment for binary tools", () => {
		expect(levelBar("off", BINARY)).toBe("▱");
		expect(levelBar("on", BINARY)).toBe("▰");
	});

	it("treats an unknown value as off (no fill)", () => {
		expect(levelBar("???", PONYTAIL)).toBe("▱▱▱");
	});

	it("returns empty string when there are no non-off steps", () => {
		expect(levelBar("off", ["off"])).toBe("");
	});
});

describe("buildOptHelp", () => {
	it("lists every tool with its current value", () => {
		const help = buildOptHelp(fakeHandles());
		expect(help).toContain("caveman: full");
		expect(help).toContain("rtk: on");
		expect(help).not.toContain("toon");
		expect(help).toContain("ponytail: off");
		expect(help).toContain("caveman help");
	});
});
