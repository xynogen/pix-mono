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
	toggleLevel,
} from "./caveman.ts";

// ── LEVELS ────────────────────────────────────────────────────────────────────

describe("LEVELS", () => {
	it("contains off as first entry", () => {
		expect(LEVELS[0]).toBe("off");
	});

	it("contains all expected levels", () => {
		const expected: Level[] = ["off", "lite", "full", "ultra", "micro"];
		for (const l of expected) expect(LEVELS).toContain(l);
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

	it("latin levels are uppercase", () => {
		expect(STATUS_LABELS.lite).toBe("LITE");
		expect(STATUS_LABELS.full).toBe("FULL");
		expect(STATUS_LABELS.ultra).toBe("ULTRA");
		expect(STATUS_LABELS.micro).toBe("MICRO");
	});
});

// ── resolveLevel ──────────────────────────────────────────────────────────────

describe("resolveLevel", () => {
	it("resolves valid levels", () => {
		expect(resolveLevel("lite")).toBe("lite");
		expect(resolveLevel("full")).toBe("full");
		expect(resolveLevel("ultra")).toBe("ultra");
		expect(resolveLevel("micro")).toBe("micro");
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

	it("does not mention wenyan", () => {
		expect(buildHelp("off").toLowerCase()).not.toContain("wenyan");
	});
});

// ── toggleLevel ───────────────────────────────────────────────────────────────

describe("toggleLevel", () => {
	it("off → full", () => {
		expect(toggleLevel("off")).toBe("full");
	});

	it("full → off", () => {
		expect(toggleLevel("full")).toBe("off");
	});

	it("any non-off level → off", () => {
		const nonOff = LEVELS.filter((l) => l !== "off") as Level[];
		for (const l of nonOff) {
			expect(toggleLevel(l)).toBe("off");
		}
	});
});

// ── buildPrompt ───────────────────────────────────────────────────────────────

describe("buildPrompt", () => {
	it("returns empty string for off", () => {
		expect(buildPrompt("off")).toBe("");
	});

	it("keeps every active prompt focused on reply length", () => {
		for (const level of ["micro", "lite", "full", "ultra"] as const) {
			const prompt = buildPrompt(level);
			expect(prompt.length).toBeGreaterThan(0);
			expect(prompt.length).toBeLessThanOrEqual(300);
			for (const rule of [
				"# Reply length",
				"without losing meaning, required detail, or safety checks",
				"Explain fully when asked",
				'"stop caveman" or "normal mode"',
			]) {
				expect(prompt).toContain(rule);
			}
			// Regression: the optimizer must not duplicate SOP's STE rules.
			expect(prompt).not.toContain("STE");
		}
	});

	it("adds distinct intensity instructions to the compact base", () => {
		const base = buildPrompt("micro");
		for (const level of ["lite", "full", "ultra"] as const) {
			expect(buildPrompt(level).startsWith(`${base}\n`)).toBe(true);
		}
		expect(buildPrompt("lite")).toContain("Keep useful context");
		expect(buildPrompt("full")).toContain("Avoid repetition");
		expect(buildPrompt("ultra")).toContain("shortest complete answer");
	});
});
