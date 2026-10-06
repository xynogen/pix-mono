import { describe, expect, it } from "bun:test";
import type { ModelsDevModel, RouterModel } from "./data.ts";
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
	it("uses devModel modalities when present", () => {
		const model: RouterModel = { id: "some-model" };
		const dev: ModelsDevModel = {
			id: "some-model",
			modalities: { input: ["text", "image"] },
		};
		expect(getInputTypes(model, dev)).toEqual(["text", "image"]);
	});

	it("filters out non text/image modalities from devModel", () => {
		const model: RouterModel = { id: "some-model" };
		const dev: ModelsDevModel = {
			id: "some-model",
			modalities: { input: ["text", "audio"] },
		};
		expect(getInputTypes(model, dev)).toEqual(["text"]);
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

	it("returns text-only for unknown model with no devModel", () => {
		expect(getInputTypes({ id: "some-random-llm" })).toEqual(["text"]);
	});

	it("uses devModel over pattern when both match", () => {
		const model: RouterModel = { id: "claude-opus-4" };
		const dev: ModelsDevModel = {
			id: "claude-opus-4",
			modalities: { input: ["text"] }, // explicitly text-only despite claude pattern
		};
		expect(getInputTypes(model, dev)).toEqual(["text"]);
	});
});

// ── getModelName ─────────────────────────────────────────────────────────────

describe("getModelName", () => {
	it("prefers router model.name", () => {
		expect(getModelName({ id: "x", name: "Router Name" }, { id: "x", name: "Dev Name" })).toBe(
			"Router Name",
		);
	});

	it("falls back to devModel.name", () => {
		expect(getModelName({ id: "x" }, { id: "x", name: "Dev Name" })).toBe("Dev Name");
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
			getContextWindow(
				{ id: "x", context_window: 32_000 },
				{ id: "x", limit: { context: 100_000 } },
			),
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

	it("capabilities.contextWindow beats devModel.limit.context", () => {
		expect(
			getContextWindow(
				{ id: "x", capabilities: { contextWindow: 1_000_000 } },
				{ id: "x", limit: { context: 200_000 } },
			),
		).toBe(1_000_000);
	});

	it("falls back to devModel.limit.context", () => {
		expect(getContextWindow({ id: "x" }, { id: "x", limit: { context: 200_000 } })).toBe(200_000);
	});

	it("falls back to DEFAULT_CONTEXT_WINDOW", () => {
		expect(getContextWindow({ id: "x" })).toBe(128_000);
	});
});

// ── getMaxTokens ──────────────────────────────────────────────────────────────

describe("getMaxTokens", () => {
	it("prefers model.max_tokens", () => {
		expect(
			getMaxTokens({ id: "x", max_tokens: 4_096 }, { id: "x", limit: { output: 32_000 } }),
		).toBe(4_096);
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

	it("capabilities.maxOutput beats devModel.limit.output", () => {
		expect(
			getMaxTokens(
				{ id: "x", capabilities: { maxOutput: 64_000 } },
				{ id: "x", limit: { output: 16_000 } },
			),
		).toBe(64_000);
	});

	it("falls back to devModel.limit.output", () => {
		expect(getMaxTokens({ id: "x" }, { id: "x", limit: { output: 16_000 } })).toBe(16_000);
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
		const mapper = toModelConfig(new Map());
		for (const id of ["cx/gpt-6.1-sol", "cx/gpt-5.4", "gpt-5"]) {
			expect(mapper({ id }).reasoning).toBe(true);
		}
		expect(getReasoning({ id: "cx/gpt-4.1" })).toBe(false);
		expect(getReasoning({ id: "cx/gpt-6.1-sol" }, { id: "gpt-6.1", reasoning: false })).toBe(false);
	});

	it("uses devModel.reasoning when boolean true", () => {
		expect(getReasoning({ id: "x" }, { id: "x", reasoning: true })).toBe(true);
	});

	it("uses devModel.reasoning when boolean false", () => {
		// even if pattern would match, devModel wins
		expect(getReasoning({ id: "claude-opus-4" }, { id: "claude-opus-4", reasoning: false })).toBe(
			false,
		);
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

	it("returns false for plain model with no devModel", () => {
		expect(getReasoning({ id: "llama-3-8b-instruct" })).toBe(false);
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
		const mapper = toModelConfig(new Map());
		const config = mapper({ id: "oc/jev-1.13-free", contextWindow: 200_000 });
		expect(config.type).toBe("classifier");
		expect((config as any).api).toBe("typesafe-system-one");
		expect(config.contextWindow).toBe(200_000);
		expect((config as any).compat).toBeUndefined();
	});

	it("configures chat models without classifier type and with compat", () => {
		const mapper = toModelConfig(new Map());
		const config = mapper({ id: "ag/gemini-3.8-flash", contextWindow: 1_000_000 });
		expect(config.type).toBeUndefined();
		expect((config as any).compat).toBeDefined();
		expect(config.contextWindow).toBe(1_000_000);
	});
});

// ── classifySystemOne ────────────────────────────────────────────────────────

describe("classifySystemOne", () => {
	it("translates bool to noul and parses response", async () => {
		const origFetch = globalThis.fetch;
		let sentBody: any;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			sentBody = JSON.parse(init?.body as string);
			return new Response(
				JSON.stringify({
					model: "jev-1.13-free",
					answers: {
						check: { type: "noul", noul: 0.92 },
					},
					usage: { input_tokens: 100, output_tokens: 10 },
				}),
				{ status: 200 },
			);
		}) as any;

		try {
			const res = await classifySystemOne(
				{ id: "oc/jev-1.13-free", baseUrl: "https://router.dev/v1" },
				{
					state: { prompt: "test" },
					questions: {
						check: {
							type: "bool",
							instructions: "is bool",
							criteria: { true: "y", false: "n" },
						},
					},
				},
				"test-key",
			);

			expect(sentBody.questions.check.type).toBe("noul");
			expect(res.stopReason).toBe("stop");
			expect(res.answers.check).toEqual({ type: "bool", probability: 0.92 });
			expect(res.usage?.input).toBe(100);
			expect(res.usage?.output).toBe(10);
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("handles http errors gracefully", async () => {
		const origFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			return new Response("Bad request", { status: 400 });
		}) as any;

		try {
			const res = await classifySystemOne(
				{ id: "oc/jev-1.13-free" },
				{ state: {}, questions: {} },
				"test-key",
			);
			expect(res.stopReason).toBe("error");
			expect(res.errorMessage).toContain("400");
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});
