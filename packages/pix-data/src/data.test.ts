import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { pixRuntime } from "@xynogen/pix-runtime/config";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { ioSection } from "@xynogen/pix-runtime/sections";
import {
	benchlm,
	buildModelsDevIndex,
	DataSource,
	formatCost,
	fromRegisteredModel,
	lookupBenchmark,
	lookupInIndex,
	lookupModelsDev,
	type ModelGrepModel,
	mergeModelsDev,
	modelgrep,
	resolveModelsDev,
} from "./data.ts";

// Compact modelgrep-shaped fixture builder.
function mg(
	id: string,
	opts: {
		name?: string;
		ctx?: number;
		in?: number;
		out?: number;
		reasoning?: boolean;
		input?: string[];
		// Raw benchmark inputs to codingScore. intelligence (~0–65) wins when
		// present; otherwise coding/agentic (0–100) + rest (0–1) feed the heuristic.
		bench?: {
			intelligence?: number;
			coding?: number;
			agentic?: number;
			gpqa?: number;
			scicode?: number;
			tau2?: number;
			hle?: number;
		};
	} = {},
): ModelGrepModel {
	return {
		id,
		name: opts.name ?? id,
		context_length: opts.ctx,
		pricing: { input: opts.in, output: opts.out },
		modality: { input: opts.input },
		capabilities: { reasoning: opts.reasoning },
		benchmarks: { artificial_analysis: { ...opts.bench } },
	};
}

describe("DataSource", () => {
	it("uses stale cache silently when refresh fails", async () => {
		const cachePath = `${tempDir()}/pix-data-stale-${process.pid}-${Date.now()}.json`;
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await writeFile(cachePath, JSON.stringify({ ts: 0, data: ["cached"] }));
			const source = new DataSource<string[]>({
				label: "test",
				url: "https://example.test/data",
				cachePath,
				ttlMs: 0,
				fetchRaw: async () => {
					throw new Error("offline");
				},
				parse: () => [],
				parseCache: (data) => data as string[],
				empty: [],
			});

			expect(await source.get()).toEqual(["cached"]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			await rm(cachePath, { force: true });
		}
	});

	it("uses the shared timeout when a data source has no explicit override", async () => {
		const cachePath = `${tempDir()}/pix-data-timeout-${process.pid}-${Date.now()}.json`;
		await pixRuntime().update(ioSection, { timeoutSec: 120 });
		try {
			let seenTimeout = 0;
			const source = new DataSource<string[]>({
				label: "test",
				url: "https://example.test/data",
				cachePath,
				fetchRaw: async (_url, _headers, timeoutMs) => {
					seenTimeout = timeoutMs;
					return { data: [] };
				},
				parse: () => [],
				parseCache: () => [],
				empty: [],
			});

			await source.get();
			expect(seenTimeout).toBe(120_000);
		} finally {
			await pixRuntime().update(ioSection, { timeoutSec: 30 });
			await rm(cachePath, { force: true });
		}
	});

	it("refetches instead of throwing when a fresh cache has an old shape", async () => {
		const cachePath = `${tempDir()}/pix-data-shape-${process.pid}-${Date.now()}.json`;
		try {
			await writeFile(cachePath, JSON.stringify({ ts: Date.now(), data: { legacy: true } }));
			let fetches = 0;
			const source = new DataSource<string[]>({
				label: "test",
				url: "https://example.test/data",
				cachePath,
				ttlMs: 60_000,
				fetchRaw: async () => {
					fetches++;
					return ["fresh"];
				},
				parse: (raw) => raw as string[],
				parseCache: (data) => {
					if (!Array.isArray(data)) throw new Error("old cache shape");
					return data as string[];
				},
				empty: [],
			});

			expect(await source.get()).toEqual(["fresh"]);
			expect(fetches).toBe(1);
			expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({ data: ["fresh"] });
		} finally {
			await rm(cachePath, { force: true });
		}
	});
});

// ── buildModelsDevIndex ──────────────────────────────────────────────────────

describe("buildModelsDevIndex", () => {
	const catalog: ModelGrepModel[] = [
		mg("anthropic/claude-sonnet-4-5", { name: "Claude Sonnet 4.5" }),
		mg("anthropic/claude-opus-4", { name: "Claude Opus 4", reasoning: true }),
		mg("openai/gpt-4o", { name: "GPT-4o", input: ["text", "image"] }),
	];

	it("indexes all models by slug", () => {
		const idx = buildModelsDevIndex(catalog);
		expect(idx.has("claude-sonnet-4-5")).toBe(true);
		expect(idx.has("claude-opus-4")).toBe(true);
		expect(idx.has("gpt-4o")).toBe(true);
	});

	it("indexes normalized slug (strip date suffix)", () => {
		const idx = buildModelsDevIndex([
			mg("anthropic/claude-sonnet-4-5-20250514", { name: "Claude Sonnet 4.5" }),
		]);
		expect(idx.has("claude-sonnet-4-5")).toBe(true);
	});

	it("handles empty catalog", () => {
		expect(buildModelsDevIndex([]).size).toBe(0);
	});

	it("maps fields onto ModelsDevModel shape", () => {
		const m = buildModelsDevIndex([
			mg("openai/gpt-4o", { ctx: 128000, in: 5, out: 15, input: ["text"] }),
		]).get("gpt-4o");
		expect(m?.limit?.context).toBe(128000);
		expect(m?.cost?.input).toBe(5);
		expect(m?.cost?.output).toBe(15);
		expect(m?.modalities?.input).toEqual(["text"]);
	});

	it("preserves first-seen on slug collision", () => {
		const idx = buildModelsDevIndex([
			mg("a/gpt-4o", { name: "First" }),
			mg("b/gpt-4o", { name: "Second" }),
		]);
		expect(idx.get("gpt-4o")?.name).toBe("First");
	});
});

// ── lookupInIndex ────────────────────────────────────────────────────────────

describe("lookupInIndex", () => {
	const index = buildModelsDevIndex([
		mg("anthropic/claude-sonnet-4-5", { name: "Claude Sonnet 4.5" }),
		mg("anthropic/claude-opus-4", { name: "Claude Opus 4" }),
		mg("openai/gpt-4o", { name: "GPT-4o" }),
		mg("openai/o3-mini", { name: "o3 mini" }),
	]);

	it("finds exact match", () => {
		expect(lookupInIndex("claude-sonnet-4-5", index)?.name).toBe("Claude Sonnet 4.5");
	});

	it("strips provider prefix (provider/model)", () => {
		expect(lookupInIndex("anthropic/claude-opus-4", index)?.name).toBe("Claude Opus 4");
	});

	it("strips deep prefix (cc/model)", () => {
		expect(lookupInIndex("cc/claude-opus-4", index)?.name).toBe("Claude Opus 4");
	});

	it("strips date suffix", () => {
		expect(lookupInIndex("claude-sonnet-4-5-20250514", index)?.name).toBe("Claude Sonnet 4.5");
	});

	it("strips provider prefix + date suffix", () => {
		expect(lookupInIndex("anthropic/claude-sonnet-4-5-20250514", index)?.name).toBe(
			"Claude Sonnet 4.5",
		);
	});

	it("returns undefined for unknown model", () => {
		expect(lookupInIndex("nonexistent-xyz", index)).toBeUndefined();
	});

	it("finds o3-mini", () => {
		expect(lookupInIndex("o3-mini", index)?.name).toBe("o3 mini");
	});
});

// ── modelgrep adapters (lookupModelsDev + lookupBenchmark) ────────────────────

describe("modelgrep adapters", () => {
	const catalog: ModelGrepModel[] = [
		mg("anthropic/claude-haiku-4.5", {
			name: "Anthropic: Claude Haiku 4.5",
			ctx: 200000,
			in: 1,
			out: 5,
			input: ["text", "image"],
			bench: {
				coding: 43.9,
				agentic: 16.4,
				gpqa: 0.672,
				scicode: 0.433,
				tau2: 0.547,
				hle: 0.097,
			},
		}),
		mg("tencent/hy3-preview", {
			name: "Tencent: hy3 preview",
			ctx: 256000,
			in: 0,
			out: 0,
			reasoning: true,
			// coding/agentic absent — only raw benches → renormalized over present
			bench: { gpqa: 0.732, scicode: 0.394, tau2: 0.675, hle: 0.063 },
		}),
		mg("ghost/unbenched", { name: "Ghost" }), // no signal at all
	];

	beforeEach(() => {
		(modelgrep as unknown as { _mem: ModelGrepModel[] })._mem = catalog;
	});
	afterEach(() => {
		(modelgrep as unknown as { _mem: ModelGrepModel[] | null })._mem = null;
	});

	it("lookupModelsDev finds haiku via slug, ignoring routing prefix + date", () => {
		const m = lookupModelsDev("cc", "claude-haiku-4-5-20251001");
		expect(m?.limit?.context).toBe(200000);
		expect(m?.cost?.input).toBe(1);
	});

	it("lookupModelsDev finds hy3 via prefix + suffix strip", () => {
		expect(lookupModelsDev("openrouter", "tencent/hy3-preview:nitro")?.limit?.context).toBe(256000);
	});

	it("lookupModelsDev returns undefined for unknown model", () => {
		expect(lookupModelsDev("cc", "nonexistent-xyz")).toBeUndefined();
	});

	it("lookupBenchmark falls back to fitted heuristic (no intelligence)", () => {
		const b = lookupBenchmark("claude-haiku-4-5-20251001");
		// no intelligence → 120.6·heur − 10.6 → 42
		expect(b?.overallScore).toBe(42);
		expect(b?.rank).toBe(2); // ranked by score: hy3 (58) > haiku (42)
		expect(b?.inputPrice).toBe(1);
		expect(b?.outputPrice).toBe(5);
	});

	it("lookupBenchmark renormalizes heuristic over present benches", () => {
		const b = lookupBenchmark("tencent/hy3-preview:nitro");
		// coding/agentic indices absent → heuristic renormalizes → fitted → 58
		expect(b?.overallScore).toBe(58);
		expect(b?.rank).toBe(1);
	});

	it("lookupBenchmark returns null score when no benches at all", () => {
		const b = lookupBenchmark("ghost/unbenched");
		expect(b?.overallScore).toBeNull();
		expect(b?.rank).toBe(3); // unscored sinks to the bottom
	});

	it("lookupBenchmark prefers AA intelligence index over heuristic", () => {
		(modelgrep as unknown as { _mem: ModelGrepModel[] })._mem = [
			mg("openai/gpt-5", { bench: { intelligence: 52, coding: 10 } }),
		];
		const b = lookupBenchmark("gpt-5");
		// intelligence present → round(52 / 65 * 100) = 80, ignores low coding
		expect(b?.overallScore).toBe(80);
	});

	it("lookupBenchmark returns undefined for unknown model", () => {
		expect(lookupBenchmark("nonexistent-model-xyz")).toBeUndefined();
	});
});

// ── benchlm fallback (modelgrep AA null → benchlm) ────────────────────────────

describe("benchlm fallback", () => {
	// modelgrep catalog: every model has null benchmarks (real-world shape today)
	const catalog: ModelGrepModel[] = [
		mg("anthropic/claude-opus-4-8", { name: "Claude Opus 4.8" }),
		mg("minimax/minimax-m3", { name: "MiniMax M3" }),
		mg("deepseek/deepseek-v4-pro", { name: "DeepSeek V4 Pro" }),
		mg("qwen/qwen3.7-max", { name: "Qwen3.7 Max" }),
		mg("ghost/uncataloged", { name: "Ghost" }), // not in benchlm either
	];
	// benchlm: real shape (no benchmarks field, just overallScore 0-100)
	const benchlmEntries = [
		{ rank: 1, model: "Claude Opus 4.8 (Max)", overallScore: 95 },
		{ rank: 2, model: "Claude Opus 4.8", overallScore: 93 },
		{ rank: 25, model: "MiniMax M3", overallScore: 78 },
		{ rank: 39, model: "DeepSeek V4 Pro", overallScore: 68 },
		{ rank: 10, model: "Qwen3.7 Max", overallScore: 90 },
	];

	beforeEach(() => {
		(modelgrep as unknown as { _mem: ModelGrepModel[] })._mem = catalog;
		(benchlm as unknown as { _mem: typeof benchlmEntries })._mem = benchlmEntries;
	});
	afterEach(() => {
		(modelgrep as unknown as { _mem: ModelGrepModel[] | null })._mem = null;
		(benchlm as unknown as { _mem: typeof benchlmEntries | null })._mem = null;
	});

	it("falls back to benchlm when modelgrep benchmarks are null", () => {
		const b = lookupBenchmark("claude-opus-4-8");
		// Two candidates: (Max)=95, base=93 → pick higher
		expect(b?.overallScore).toBe(95);
	});

	it("prefers the higher-scoring benchlm variant when multiple match", () => {
		const b = lookupBenchmark("minimax-m3");
		expect(b?.overallScore).toBe(78);
	});

	it("returns null when both modelgrep and benchlm lack the model", () => {
		const b = lookupBenchmark("uncataloged");
		expect(b?.overallScore).toBeNull();
	});

	it("ranks scored models above unscored when only some have benchlm data", () => {
		// catalog has 5 models, 4 in benchlm → uncataloged sinks to last
		const b = lookupBenchmark("uncataloged");
		expect(b?.rank).toBe(5); // 4 scored + 1 unscored at bottom
	});

	it("normalizes dots and parens: qwen3.7-max ↔ Qwen3.7 Max", () => {
		const b = lookupBenchmark("qwen3.7-max");
		expect(b?.overallScore).toBe(90);
	});
});

describe("modelgrep AA primary wins over benchlm", () => {
	const catalog: ModelGrepModel[] = [
		mg("anthropic/claude-opus-4-8", {
			bench: { intelligence: 60 }, // AA index: 60/65 → 92
		}),
	];
	const benchlmEntries = [{ rank: 1, model: "Claude Opus 4.8", overallScore: 50 }];

	beforeEach(() => {
		(modelgrep as unknown as { _mem: ModelGrepModel[] })._mem = catalog;
		(benchlm as unknown as { _mem: typeof benchlmEntries })._mem = benchlmEntries;
	});
	afterEach(() => {
		(modelgrep as unknown as { _mem: ModelGrepModel[] | null })._mem = null;
		(benchlm as unknown as { _mem: typeof benchlmEntries | null })._mem = null;
	});

	it("uses AA intelligence when present, ignores benchlm", () => {
		const b = lookupBenchmark("claude-opus-4-8");
		// 60/65 * 100 = 92.23 → 92, not benchlm's 50
		expect(b?.overallScore).toBe(92);
	});
});

describe("fromRegisteredModel", () => {
	it("maps Pi Model fields into ModelsDevModel shape", () => {
		const m = fromRegisteredModel({
			id: "gateway/composer-2.5",
			name: "Composer 2.5",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200000,
			maxTokens: 16384,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		});
		expect(m).toEqual({
			id: "composer-2.5", // slug — maker prefix stripped
			name: "Composer 2.5",
			reasoning: true,
			modalities: { input: ["text", "image"] },
			limit: { context: 200000, output: 16384 },
			cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
		});
	});

	it("accepts snake_case cache rates and free (0) cost", () => {
		const m = fromRegisteredModel({ id: "x", cost: { input: 0, output: 0, cache_read: 0 } });
		expect(m?.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: undefined });
	});

	it("returns undefined for null or an all-empty model", () => {
		expect(fromRegisteredModel(null)).toBeUndefined();
		expect(fromRegisteredModel({})).toBeUndefined();
		// cost object present but with no known rate → still empty
		expect(fromRegisteredModel({ cost: { cacheRead: 1 } })).toBeUndefined();
	});
});

describe("mergeModelsDev", () => {
	const catalog = {
		id: "m",
		name: "Catalog Name",
		cost: { input: 2, output: 8 },
	};

	it("fills missing catalog cost/context from the registered model", () => {
		const merged = mergeModelsDev(
			{ id: "m", name: "Cat" }, // no cost, no limit
			{ id: "m", contextWindow: 128000, cost: { input: 1, output: 4 } },
		);
		expect(merged?.cost).toEqual({
			input: 1,
			output: 4,
			cache_read: undefined,
			cache_write: undefined,
		});
		expect(merged?.limit?.context).toBe(128000);
	});

	it("prefers catalog cost when the catalog already has a rate", () => {
		const merged = mergeModelsDev(catalog, { id: "m", cost: { input: 99, output: 99 } });
		expect(merged?.cost).toEqual({ input: 2, output: 8 });
		expect(merged?.name).toBe("Catalog Name");
	});

	it("returns whichever side is present when the other is missing", () => {
		expect(mergeModelsDev(catalog, null)).toBe(catalog);
		expect(mergeModelsDev(undefined, { id: "z", cost: { input: 1, output: 1 } })?.id).toBe("z");
		expect(mergeModelsDev(undefined, null)).toBeUndefined();
	});
});

describe("resolveModelsDev fallback", () => {
	const catalog: ModelGrepModel[] = [mg("anthropic/claude-x", { ctx: 200000, in: 3, out: 15 })];
	beforeEach(() => {
		(modelgrep as unknown as { _mem: ModelGrepModel[] })._mem = catalog;
	});
	afterEach(() => {
		(modelgrep as unknown as { _mem: ModelGrepModel[] | null })._mem = null;
	});

	it("uses catalog when the model is listed", () => {
		const d = resolveModelsDev("anthropic", "claude-x");
		expect(d?.cost?.input).toBe(3);
		expect(d?.limit?.context).toBe(200000);
	});

	it("falls back to the registered model for an off-catalog id", () => {
		const d = resolveModelsDev("gateway", "composer-2.5", {
			id: "composer-2.5",
			contextWindow: 128000,
			cost: { input: 1, output: 4 },
		});
		expect(d?.cost?.input).toBe(1);
		expect(d?.limit?.context).toBe(128000);
	});
});

describe("formatCost", () => {
	it("prints $input/$output per 1M tokens, decimals only when needed", () => {
		expect(formatCost(3, 15)).toBe("$3/$15");
		expect(formatCost(0.25, 1.25)).toBe("$0.25/$1.25");
		expect(formatCost(0.1, 2)).toBe("$0.1/$2");
	});
	it("gives free when both are 0 and undefined when both are unknown", () => {
		expect(formatCost(0, 0)).toBe("free");
		expect(formatCost(undefined, undefined)).toBeUndefined();
	});
});
