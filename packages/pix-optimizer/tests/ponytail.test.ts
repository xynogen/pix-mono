import { describe, expect, it } from "bun:test";
import {
	buildHelp,
	buildPrompt,
	LEVEL_NUMBERS,
	LEVELS,
	type Level,
	resolveLevel,
	STATUS_LABELS,
	STOP_ALIASES,
} from "../src/ponytail.ts";

// ── LEVELS ────────────────────────────────────────────────────────────────────

describe("LEVELS", () => {
	it("contains off as first entry", () => {
		expect(LEVELS[0]).toBe("off");
	});

	it("contains all expected levels", () => {
		const expected: Level[] = ["off", "lite", "full", "ultra"];
		for (const l of expected) expect(LEVELS).toContain(l);
	});

	it("has no micro level (caveman-only)", () => {
		expect(LEVELS).not.toContain("micro" as Level);
	});
});

// ── STOP_ALIASES ──────────────────────────────────────────────────────────────

describe("STOP_ALIASES", () => {
	it("includes off, stop, quit", () => {
		expect(STOP_ALIASES.has("off")).toBe(true);
		expect(STOP_ALIASES.has("stop")).toBe(true);
		expect(STOP_ALIASES.has("quit")).toBe(true);
	});

	it("does not include active levels", () => {
		expect(STOP_ALIASES.has("full")).toBe(false);
		expect(STOP_ALIASES.has("ultra")).toBe(false);
	});
});

// ── STATUS_LABELS ─────────────────────────────────────────────────────────────

describe("STATUS_LABELS", () => {
	it("has a label for every non-off level", () => {
		const nonOff = LEVELS.filter((l) => l !== "off") as Exclude<Level, "off">[];
		for (const l of nonOff) {
			expect(STATUS_LABELS[l]).toBeTruthy();
		}
	});

	it("levels are uppercase", () => {
		expect(STATUS_LABELS.lite).toBe("LITE");
		expect(STATUS_LABELS.full).toBe("FULL");
		expect(STATUS_LABELS.ultra).toBe("ULTRA");
	});
});

// ── resolveLevel ──────────────────────────────────────────────────────────────

describe("resolveLevel", () => {
	it("resolves valid levels", () => {
		expect(resolveLevel("lite")).toBe("lite");
		expect(resolveLevel("full")).toBe("full");
		expect(resolveLevel("ultra")).toBe("ultra");
		expect(resolveLevel("off")).toBe("off");
	});

	it("maps stop aliases to off", () => {
		expect(resolveLevel("stop")).toBe("off");
		expect(resolveLevel("quit")).toBe("off");
	});

	it("is case-insensitive", () => {
		expect(resolveLevel("FULL")).toBe("full");
		expect(resolveLevel("Ultra")).toBe("ultra");
		expect(resolveLevel("STOP")).toBe("off");
	});

	it("trims whitespace", () => {
		expect(resolveLevel("  full  ")).toBe("full");
	});

	it("returns null for unknown input", () => {
		expect(resolveLevel("unknown")).toBeNull();
		expect(resolveLevel("")).toBeNull();
		expect(resolveLevel("config")).toBeNull(); // config handled separately
		expect(resolveLevel("micro")).toBeNull(); // no micro level
	});
});

// ── numeric levels ────────────────────────────────────────────────────────────

describe("numeric levels", () => {
	it("maps 1/2/3 to lite/full/ultra", () => {
		expect(resolveLevel("1")).toBe("lite");
		expect(resolveLevel("2")).toBe("full");
		expect(resolveLevel("3")).toBe("ultra");
	});

	it("maps 0 to off", () => {
		expect(resolveLevel("0")).toBe("off");
	});

	it("LEVEL_NUMBERS only covers 1-3", () => {
		expect(Object.keys(LEVEL_NUMBERS).sort()).toEqual(["1", "2", "3"]);
	});

	it("rejects out-of-range numbers", () => {
		expect(resolveLevel("4")).toBeNull();
		expect(resolveLevel("9")).toBeNull();
	});

	it("trims whitespace around numbers", () => {
		expect(resolveLevel("  2  ")).toBe("full");
	});
});

// ── buildHelp ─────────────────────────────────────────────────────────────────

describe("buildHelp", () => {
	it("lists numeric shortcuts", () => {
		const help = buildHelp("off");
		expect(help).toContain("1");
		expect(help).toContain("lite");
		expect(help).toContain("2");
		expect(help).toContain("full");
		expect(help).toContain("3");
		expect(help).toContain("ultra");
	});

	it("shows current level when active", () => {
		expect(buildHelp("ultra")).toContain("ULTRA");
	});

	it("shows off when disabled", () => {
		expect(buildHelp("off")).toContain("off");
	});

	it("mentions config", () => {
		expect(buildHelp("off")).toContain("config");
	});
});

// ── buildPrompt ───────────────────────────────────────────────────────────────

describe("buildPrompt", () => {
	it("returns empty string for off", () => {
		expect(buildPrompt("off")).toBe("");
	});

	it("includes BASE ladder for all active levels", () => {
		for (const l of ["lite", "full", "ultra"] as Level[]) {
			expect(buildPrompt(l)).toContain("PONYTAIL MODE ACTIVE");
			expect(buildPrompt(l)).toContain("first rung that holds");
		}
	});

	it("includes SAFETY clause for all active levels", () => {
		for (const l of ["lite", "full", "ultra"] as Level[]) {
			expect(buildPrompt(l)).toContain("When not to be lazy");
		}
	});

	it("preserves context, implementation initiative, and user control at every active level", () => {
		for (const level of LEVELS.filter((level) => level !== "off")) {
			const prompt = buildPrompt(level);
			expect(prompt).toContain("fulfills the user's goal in context");
			expect(prompt).toContain("not the narrowest reading of the latest message");
			expect(prompt).toContain("Make routine implementation decisions yourself");
			expect(prompt).toContain(
				"ask only when unresolved uncertainty materially affects scope, cost, or safety",
			);
			expect(prompt).toContain("match the user's requested format and level of detail");
			expect(prompt).not.toMatch(
				/Never stop for an answer|at most three short lines|name the lazier alternative|challenge the rest|do not choose the scope for the user/,
			);
		}
	});

	it("each level has distinct intensity instructions", () => {
		const lite = buildPrompt("lite");
		const ultra = buildPrompt("ultra");
		expect(lite).toContain("Mention a simpler alternative only when");
		expect(ultra).toContain("Apply YAGNI strictly to unrequested extras");
		expect(lite).not.toContain("Apply YAGNI strictly");
	});
});
