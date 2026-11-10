import { describe, expect, it } from "bun:test";
import type { RouterModel } from "./data.ts";
import {
	classifySystemOne,
	getContextWindow,
	getInputTypes,
	getMaxTokens,
	getModelName,
	getReasoning,
	isClassifierModel,
	toModelConfig,
} from "./provider.ts";

// ── getInputTypes ────────────────────────────────────────────────────────────

describe("getInputTypes", () => {
	it("uses router capabilities.vision when present", () => {
		expect(getInputTypes({ id: "some-model", capabilities: { vision: true } })).toEqual([
			"text",
			"image",
		]);
	});

	it("falls back to pattern match for claude", () => {
		expect(getInputTypes({ id: "claude-sonnet-4-5" })).toEqual(["text", "image"]);
	});

	it("falls back to pattern match for gpt-4o", () => {
		expect(getInputTypes({ id: "gpt-4o" })).toEqual(["text", "image"]);
	});

	it("falls back to pattern match for kimi-k2", () => {
		expect(getInputTypes({ id: "kimi-k2-instruct" })).toEqual(["text", "image"]);
	});

	it("returns text-only for unknown model without router capabilities", () => {
		expect(getInputTypes({ id: "some-random-llm" })).toEqual(["text"]);
	});

	it("router capabilities.vision beats the name pattern", () => {
		const model: RouterModel = { id: "claude-opus-4", capabilities: { vision: false } };
		expect(getInputTypes(model)).toEqual(["text"]);
	});
});

// ── getModelName ─────────────────────────────────────────────────────────────

describe("getModelName", () => {
	it("prefers router model.name", () => {
		expect(getModelName({ id: "x", name: "Router Name" })).toBe("Router Name");
	});

	it("falls back to model.id", () => {
		expect(getModelName({ id: "some-id" })).toBe("some-id");
	});

	it("returns 'unknown' when all empty", () => {
		expect(getModelName({})).toBe("unknown");
	});
});

// ── getContextWindow ──────────────────────────────────────────────────────────

describe("getContextWindow", () => {
	it("prefers model.context_window", () => {
		expect(
			getContextWindow({
				id: "x",
				context_window: 32_000,
				capabilities: { contextWindow: 100_000 },
			}),
		).toBe(32_000);
	});

	it("falls back to model.contextWindow", () => {
		expect(getContextWindow({ id: "x", contextWindow: 64_000 })).toBe(64_000);
	});

	it("falls back to capabilities.contextWindow (9router v1 nested shape)", () => {
		expect(getContextWindow({ id: "x", capabilities: { contextWindow: 1_000_000 } })).toBe(
			1_000_000,
		);
	});

	it("top-level fields beat capabilities.contextWindow", () => {
		expect(
			getContextWindow({
				id: "x",
				contextWindow: 64_000,
				capabilities: { contextWindow: 1_000_000 },
			}),
		).toBe(64_000);
	});

	it("falls back to DEFAULT_CONTEXT_WINDOW", () => {
		expect(getContextWindow({ id: "x" })).toBe(128_000);
	});
});

// ── getMaxTokens ──────────────────────────────────────────────────────────────

describe("getMaxTokens", () => {
	it("prefers model.max_tokens", () => {
		expect(getMaxTokens({ id: "x", max_tokens: 4_096, capabilities: { maxOutput: 32_000 } })).toBe(
			4_096,
		);
	});

	it("falls back to model.maxTokens", () => {
		expect(getMaxTokens({ id: "x", maxTokens: 8_192 })).toBe(8_192);
	});

	it("falls back to capabilities.maxOutput (9router v1 nested shape)", () => {
		expect(getMaxTokens({ id: "x", capabilities: { maxOutput: 64_000 } })).toBe(64_000);
	});

	it("top-level fields beat capabilities.maxOutput", () => {
		expect(getMaxTokens({ id: "x", maxTokens: 8_192, capabilities: { maxOutput: 64_000 } })).toBe(
			8_192,
		);
	});

	it("falls back to DEFAULT_MAX_TOKENS", () => {
		expect(getMaxTokens({ id: "x" })).toBe(16_384);
	});

	it("handles the PR #9 regression case (qwen3-coder-flash nested capabilities)", () => {
		const model: RouterModel = {
			id: "alims-intl/qwen3-coder-flash-2025-07-28",
			capabilities: { contextWindow: 1_000_000, maxOutput: 64_000 },
		};
		expect(getContextWindow(model)).toBe(1_000_000);
		expect(getMaxTokens(model)).toBe(64_000);
	});
});

// ── getReasoning ──────────────────────────────────────────────────────────────

describe("getReasoning", () => {
	it("keeps the project thinking default available for cached GPT reasoning models", () => {
		for (const id of ["cx/gpt-6.1-sol", "cx/gpt-5.4", "gpt-5"]) {
			expect(toModelConfig({ id }).reasoning).toBe(true);
		}
		expect(getReasoning({ id: "cx/gpt-4.1" })).toBe(false);
	});

	it("falls back to pattern — opus", () => {
		expect(getReasoning({ id: "claude-opus-4" })).toBe(true);
	});

	it("falls back to pattern — sonnet", () => {
		expect(getReasoning({ id: "claude-sonnet-4-5" })).toBe(true);
	});

	it("falls back to pattern — thinking", () => {
		expect(getReasoning({ id: "deepseek-thinking" })).toBe(true);
	});

	it("falls back to pattern — reasoner", () => {
		expect(getReasoning({ id: "o1-reasoner" })).toBe(true);
	});

	it("returns false for plain model without router capabilities", () => {
		expect(getReasoning({ id: "llama-3-8b-instruct" })).toBe(false);
	});

	it("uses router capabilities first", () => {
		// glm-5.3-flash matches none of the fallback patterns.
		expect(getReasoning({ id: "glm-cn/glm-5.3-flash", capabilities: { reasoning: true } })).toBe(
			true,
		);
		expect(getReasoning({ id: "claude-opus-4", capabilities: { reasoning: false } })).toBe(false);
	});
});

// ── isClassifierModel & toModelConfig ────────────────────────────────────────

describe("isClassifierModel", () => {
	it("detects jev models as classifiers", () => {
		expect(isClassifierModel({ id: "oc/jev-1.13-free" })).toBe(true);
		expect(isClassifierModel({ id: "jev-latest" })).toBe(true);
		expect(isClassifierModel({ id: "typesafe/jev" })).toBe(true);
	});

	it("detects span and solar-decide models as classifiers", () => {
		expect(isClassifierModel({ id: "respan/span-01" })).toBe(true);
		expect(isClassifierModel({ id: "upstage/solar-decide" })).toBe(true);
	});

	it("does not classify chat models", () => {
		expect(isClassifierModel({ id: "ag/gemini-3.8-flash" })).toBe(false);
		expect(isClassifierModel({ id: "cx/gpt-6-sol" })).toBe(false);
		expect(isClassifierModel({ id: "cc/claude-opus-5-5" })).toBe(false);
	});

	it("respects NINEROUTER_CLASSIFIER_MODELS env var", () => {
		const prev = process.env.NINEROUTER_CLASSIFIER_MODELS;
		try {
			process.env.NINEROUTER_CLASSIFIER_MODELS = "custom-judge,my-verifier";
			expect(isClassifierModel({ id: "custom-judge-v1" })).toBe(true);
			expect(isClassifierModel({ id: "my-verifier" })).toBe(true);
			expect(isClassifierModel({ id: "other-model" })).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.NINEROUTER_CLASSIFIER_MODELS;
			else process.env.NINEROUTER_CLASSIFIER_MODELS = prev;
		}
	});
});

describe("toModelConfig", () => {
	it("configures classifier models with type classifier and system-one api", () => {
		const config = toModelConfig({ id: "oc/jev-1.13-free", contextWindow: 200_000 });
		expect(config.type).toBe("classifier");
		expect((config as any).api).toBe("typesafe-system-one");
		expect(config.contextWindow).toBe(200_000);
		expect((config as any).compat).toBeUndefined();
	});

	it("configures chat models without classifier type and with compat", () => {
		const config = toModelConfig({ id: "ag/gemini-3.8-flash", contextWindow: 1_000_000 });
		expect(config.type).toBeUndefined();
		expect((config as any).compat).toBeDefined();
		expect(config.contextWindow).toBe(1_000_000);
	});
});

// ── classifySystemOne ────────────────────────────────────────────────────────

describe("classifySystemOne", () => {
	const model = {
		type: "classifier",
		id: "oc/jev-1.13-free",
		name: "Jev",
		api: "typesafe-system-one",
		provider: "9router",
		baseUrl: "https://router.dev/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
	} as unknown as Parameters<typeof classifySystemOne>[0];
	const question = {
		check: { type: "bool", instructions: "is bool", criteria: { true: "y", false: "n" } },
	} as const;

	async function withFetch<T>(reply: () => Response, run: () => Promise<T>) {
		const origFetch = globalThis.fetch;
		const sent: { url: string; body: any; headers: Headers }[] = [];
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			sent.push({
				url: String(url),
				body: JSON.parse(String(init?.body)),
				headers: new Headers(init?.headers),
			});
			return reply();
		}) as typeof fetch;
		try {
			return { result: await run(), sent };
		} finally {
			globalThis.fetch = origFetch;
		}
	}

	it("posts to the 9router /systemone with bool as noul and parses the answer", async () => {
		const { result, sent } = await withFetch(
			() =>
				Response.json({
					answers: { check: { type: "noul", noul: 0.92 } },
					usage: { input_tokens: 100, output_tokens: 10 },
				}),
			() =>
				classifySystemOne(
					model,
					{ state: { prompt: "test" }, questions: question },
					{ apiKey: "k" },
				),
		);
		expect(sent[0]?.url).toBe("https://router.dev/v1/systemone");
		expect(sent[0]?.body).toMatchObject({
			model: "oc/jev-1.13-free",
			questions: { check: { type: "noul" } },
		});
		expect(sent[0]?.headers.get("authorization")).toBe("Bearer k");
		expect(sent[0]?.headers.get("user-agent")).toMatch(/^pi\//);
		expect(result.stopReason).toBe("stop");
		expect(result.answers.check).toEqual({ type: "bool", probability: 0.92 });
		expect(result.usage).toMatchObject({ input: 100, output: 10 });
	});

	it("reports an http error without throwing", async () => {
		const { result } = await withFetch(
			() => new Response("Bad request", { status: 400 }),
			() => classifySystemOne(model, { state: {}, questions: question }, { apiKey: "k" }),
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/400/);
	});
});
