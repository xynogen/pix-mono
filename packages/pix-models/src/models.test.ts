import { describe, expect, it } from "bun:test";
import {
	benchStars,
	filterModelItems,
	fmtCost,
	fmtCtx,
	type ModelSearchLookup,
	normalizeModelText,
	resolveContextWindow,
	sortModels,
	stepEffectiveThinkingLevel,
	stepThinkingLevel,
	THINKING_LEVELS,
} from "./models.ts";

describe("stepThinkingLevel", () => {
	it("steps up one notch", () => {
		expect(stepThinkingLevel("low", 1)).toBe("medium");
		expect(stepThinkingLevel("off", 1)).toBe("minimal");
	});
	it("steps down one notch", () => {
		expect(stepThinkingLevel("medium", -1)).toBe("low");
		expect(stepThinkingLevel("xhigh", -1)).toBe("high");
	});
	it("clamps at the low end (no wrap)", () => {
		expect(stepThinkingLevel("off", -1)).toBe("off");
	});
	it("clamps at the high end (no wrap)", () => {
		expect(stepThinkingLevel("xhigh", 1)).toBe("xhigh");
	});
	it("falls back to a medium-anchored step for unknown input", () => {
		expect(stepThinkingLevel("bogus", 1)).toBe("high");
		expect(stepThinkingLevel("", -1)).toBe("low");
	});
	it("exposes the six canonical levels ascending", () => {
		expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
	});
	it("can walk the full ladder up and back down", () => {
		let lvl: string = "off";
		for (let i = 0; i < 10; i++) lvl = stepThinkingLevel(lvl, 1);
		expect(lvl).toBe("xhigh");
		for (let i = 0; i < 10; i++) lvl = stepThinkingLevel(lvl, -1);
		expect(lvl).toBe("off");
	});
});

describe("stepEffectiveThinkingLevel", () => {
	it("skips levels that clamp back to the current level", () => {
		const clamp = (requested: string) => {
			if (requested === "minimal" || requested === "low") return "off";
			return requested;
		};
		expect(stepEffectiveThinkingLevel("off", 1, clamp)).toBe("medium");
	});

	it("stays at an endpoint when every farther request clamps back", () => {
		expect(stepEffectiveThinkingLevel("high", 1, () => "high")).toBe("high");
	});
});

describe("resolveContextWindow", () => {
	it("prefers provider contextWindow over fallback", () => {
		expect(resolveContextWindow({ contextWindow: 200_000 }, 128_000)).toBe(200_000);
	});
	it("falls back to dev limit when provider is 0/missing", () => {
		expect(resolveContextWindow({ contextWindow: 0 }, 128_000)).toBe(128_000);
		expect(resolveContextWindow({}, 64_000)).toBe(64_000);
	});
	it("ignores non-finite and negative values", () => {
		expect(resolveContextWindow({ contextWindow: Number.NaN }, 128_000)).toBe(128_000);
		expect(resolveContextWindow({ contextWindow: Number.POSITIVE_INFINITY }, 50_000)).toBe(50_000);
		expect(resolveContextWindow({ contextWindow: -1 }, 32_000)).toBe(32_000);
	});
	it("returns 0 when both missing/invalid", () => {
		expect(resolveContextWindow({}, undefined)).toBe(0);
		expect(resolveContextWindow({ contextWindow: null }, null)).toBe(0);
	});
});

describe("fmtCtx", () => {
	it("formats 0 as 0", () => expect(fmtCtx(0)).toBe("0"));
	it("formats small numbers as-is", () => expect(fmtCtx(512)).toBe("512"));
	it("formats thousands as Nk", () => {
		expect(fmtCtx(128_000)).toBe("128k");
		expect(fmtCtx(8_192)).toBe("8k");
	});
	it("formats millions as NM", () => {
		expect(fmtCtx(1_000_000)).toBe("1M");
		expect(fmtCtx(2_000_000)).toBe("2M");
		expect(fmtCtx(1_500_000)).toBe("1.5M");
	});
});

describe("fmtCost", () => {
	it("returns — for undefined entry", () => expect(fmtCost(undefined)).toBe("—"));
	it("returns — when no cost field", () => expect(fmtCost({})).toBe("—"));
	it("returns free when both 0", () => {
		expect(fmtCost({ cost: { input: 0, output: 0 } })).toBe("free");
	});
	it("formats input/output costs", () => {
		expect(fmtCost({ cost: { input: 3, output: 15 } })).toBe("3.00/15.00");
	});
	it("handles missing input/output as 0", () => {
		expect(fmtCost({ cost: {} })).toBe("free");
	});
});

describe("benchStars", () => {
	it("gives 5 stars for score >= 90", () => {
		expect(benchStars(95).filled).toBe(5);
		expect(benchStars(90).filled).toBe(5);
	});
	it("gives 4 stars for 80-89", () => {
		expect(benchStars(85).filled).toBe(4);
		expect(benchStars(80).filled).toBe(4);
	});
	it("gives 3 stars for 70-79", () => {
		expect(benchStars(75).filled).toBe(3);
	});
	it("gives 2 stars for 50-69", () => {
		expect(benchStars(60).filled).toBe(2);
		expect(benchStars(50).filled).toBe(2);
	});
	it("gives 1 star for score < 50", () => {
		expect(benchStars(30).filled).toBe(1);
		expect(benchStars(0).filled).toBe(1);
	});
	it("gives 1 star for null/undefined", () => {
		expect(benchStars(null).filled).toBe(1);
		expect(benchStars(undefined).filled).toBe(1);
	});
	it("filled + empty always = 5", () => {
		for (const s of [0, 50, 70, 80, 90, 100]) {
			const { filled, empty } = benchStars(s);
			expect(filled + empty).toBe(5);
		}
	});
});

describe("sortModels", () => {
	const models = [
		{ provider: "a", id: "m1", name: "Zebra", score: 80 },
		{ provider: "a", id: "m2", name: "Alpha", score: 95 },
		{ provider: "a", id: "m3", name: "Middle", score: null },
		{ provider: "a", id: "m4", name: "Beta", score: 80 },
	];
	type ModelEntry = (typeof models)[number];

	it("sorts by score descending", () => {
		const sorted = sortModels(models);
		expect((sorted[0] as ModelEntry).name).toBe("Alpha"); // score 95
	});

	it("breaks score ties alphabetically by name", () => {
		const sorted = sortModels(models);
		const tiedIdx = sorted.findIndex((m) => m.name === "Beta");
		const zebraIdx = sorted.findIndex((m) => m.name === "Zebra");
		expect(tiedIdx).toBeLessThan(zebraIdx); // Beta before Zebra, both score 80
	});

	it("puts null score models last", () => {
		const sorted = sortModels(models);
		expect((sorted[sorted.length - 1] as ModelEntry).name).toBe("Middle");
	});

	it("does not mutate the original array", () => {
		const original = [...models];
		sortModels(models);
		expect(models).toEqual(original);
	});

	it("puts null score models after all scored models regardless of source order", () => {
		const shuffled = [
			{ provider: "a", id: "m1", name: "Zeta", score: null },
			{ provider: "a", id: "m2", name: "Beta", score: 80 },
			{ provider: "a", id: "m3", name: "Alpha", score: 95 },
			{ provider: "a", id: "m4", name: "Gamma", score: null },
			{ provider: "a", id: "m5", name: "Delta", score: 60 },
		];
		const sorted = sortModels(shuffled);
		const lastTwo = sorted.slice(-2).map((m) => m.name);
		expect(lastTwo).toEqual(["Gamma", "Zeta"]); // nulls last, stable within
	});

	it("sinks tier 2 (off-catalog) below tier 1 (benched-but-unscored)", () => {
		// Mirrors the openrouter/owl-alpha bug: a model with no bench entry at
		// all must not interleave with benched models that happen to have a
		// null score.
		const mixed = [
			{ provider: "a", id: "m1", name: "Alpha", score: 95, tier: 0 },
			{ provider: "a", id: "m2", name: "Beta", score: null, tier: 1 },
			{ provider: "a", id: "m3", name: "Gamma", score: undefined, tier: 2 },
			{ provider: "a", id: "m4", name: "Delta", score: 60, tier: 0 },
		];
		const sorted = sortModels(mixed);
		expect(sorted.map((m) => m.name)).toEqual(["Alpha", "Delta", "Beta", "Gamma"]);
	});
});

// ─── normalizeModelText ───────────────────────────────────────────────────────

describe("normalizeModelText", () => {
	it("lowercases", () => {
		expect(normalizeModelText("GLM-5.2")).toBe("glm52");
	});

	it("strips hyphens", () => {
		expect(normalizeModelText("claude-opus-4-8")).toBe("claudeopus48");
	});

	it("strips dots", () => {
		expect(normalizeModelText("qwen3.7-max")).toBe("qwen37max");
	});

	it("strips all non-alphanumeric", () => {
		expect(normalizeModelText("a!b@c#d$e%f^g&h")).toBe("abcdefgh");
	});

	it("handles plain alphanumeric", () => {
		expect(normalizeModelText("abc123")).toBe("abc123");
	});

	it("handles empty string", () => {
		expect(normalizeModelText("")).toBe("");
	});
});

// ─── filterModelItems ─────────────────────────────────────────────────────────

describe("filterModelItems", () => {
	// Fixture: models with ids matching the acceptance criteria.
	// Ranks are assigned so some overlap with digit-queries.
	const mk = (id: string, rank?: number) => ({
		value: `p/${id}`,
		_rank: rank,
	});

	type Fixture = ReturnType<typeof mk>;

	/** Build lookup maps exactly like production: haystack = `${id} ${name ?? ""}`. */
	function buildLookup(items: Fixture[]): ModelSearchLookup {
		const rankByValue = new Map<string, number>();
		const searchTextByValue = new Map<string, string>();
		const normalizedByValue = new Map<string, string>();
		for (const it of items) {
			// value is "p/glm-5.2" — extract the id part.
			const id = it.value.split("/")[1] ?? "";
			if (it._rank != null) rankByValue.set(it.value, it._rank);
			const text = `${id} ${""}`; // no name in test fixture
			searchTextByValue.set(it.value, text);
			normalizedByValue.set(it.value, normalizeModelText(text));
		}
		return { rankByValue, searchTextByValue, normalizedByValue };
	}

	// Full fixture with ranks: glm-5.2→3, minimax-m3→8, claude-opus-4-8→2.
	const allItems: Fixture[] = [
		mk("glm-5.2", 3),
		mk("glm-5.1"),
		mk("minimax-m3", 8),
		mk("claude-opus-4-8", 2),
		mk("claude-sonnet-4-6"),
		mk("qwen3.7-max"),
	];
	const allLookup = buildLookup(allItems);

	function values(result: Fixture[]): string[] {
		return result.map((it) => it.value);
	}

	it("empty query returns all items in original order", () => {
		const result = filterModelItems(allItems, "", allLookup);
		expect(values(result)).toEqual(allItems.map((it) => it.value));
	});

	it("query '52' includes glm-5.2 via normalized substring", () => {
		const result = filterModelItems(allItems, "52", allLookup);
		expect(values(result)).toContain("p/glm-5.2");
	});

	it("query 'm3' includes minimax-m3 first (substring priority over fuzzy noise)", () => {
		const result = filterModelItems(allItems, "m3", allLookup);
		expect(values(result)[0]).toBe("p/minimax-m3");
	});

	it("query '48' includes claude-opus-4-8", () => {
		const result = filterModelItems(allItems, "48", allLookup);
		expect(values(result)).toContain("p/claude-opus-4-8");
	});

	it("exact id query 'glm-5.2' still matches glm-5.2", () => {
		const result = filterModelItems(allItems, "glm-5.2", allLookup);
		expect(values(result)).toContain("p/glm-5.2");
	});

	it("digit query matching a rank returns that ranked item first", () => {
		// glm-5.2 has rank 3 — query "3" should put it first.
		const result = filterModelItems(allItems, "3", allLookup);
		expect(values(result)[0]).toBe("p/glm-5.2");
	});

	it("dedupe: item matching both rank and substring appears once", () => {
		// claude-opus-4-8 has rank 2; query "2" matches by rank AND
		// normalized substring ("2" ⊂ "claudeopus48"). Should appear once.
		const result = filterModelItems(allItems, "2", allLookup);
		const occurrences = values(result).filter((v) => v === "p/claude-opus-4-8");
		expect(occurrences.length).toBe(1);
	});

	it("digit query '8' (rank 8) returns minimax-m3 as rank match first", () => {
		const result = filterModelItems(allItems, "8", allLookup);
		expect(values(result)[0]).toBe("p/minimax-m3");
	});

	it("whitespace query is treated as empty", () => {
		const result = filterModelItems(allItems, "   ", allLookup);
		expect(values(result)).toEqual(allItems.map((it) => it.value));
	});
});
