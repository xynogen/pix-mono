import { afterEach, describe, expect, it } from "bun:test";
import { buildModelsDevIndex, lookupInIndex, type ModelGrepModel, routerBaseUrl } from "./data.ts";

// modelgrep-shaped fixture builder (buildModelsDevIndex now takes ModelGrepModel[]).
function mg(
	id: string,
	opts: { name?: string; reasoning?: boolean; input?: string[] } = {},
): ModelGrepModel {
	return {
		id,
		name: opts.name ?? id,
		capabilities: { reasoning: opts.reasoning },
		modality: { input: opts.input },
	};
}

// ── routerBaseUrl ────────────────────────────────────────────────────────────

describe("routerBaseUrl", () => {
	const ORIGINAL_ROUTER_API_BASE = process.env.ROUTER_API_BASE;
	const ORIGINAL_NINEROUTER_URL = process.env.NINEROUTER_URL;

	afterEach(() => {
		if (ORIGINAL_ROUTER_API_BASE === undefined) delete process.env.ROUTER_API_BASE;
		else process.env.ROUTER_API_BASE = ORIGINAL_ROUTER_API_BASE;
		if (ORIGINAL_NINEROUTER_URL === undefined) delete process.env.NINEROUTER_URL;
		else process.env.NINEROUTER_URL = ORIGINAL_NINEROUTER_URL;
	});

	it("returns undefined when no URL is configured (no default host)", () => {
		delete process.env.ROUTER_API_BASE;
		delete process.env.NINEROUTER_URL;
		expect(routerBaseUrl()).toBeUndefined();
		process.env.NINEROUTER_URL = "   ";
		expect(routerBaseUrl()).toBeUndefined();
	});

	it("appends /v1 to a bare base URL", () => {
		process.env.NINEROUTER_URL = "https://router.test/";
		expect(routerBaseUrl()).toBe("https://router.test/v1");
	});

	it("uses ROUTER_API_BASE when set", () => {
		delete process.env.NINEROUTER_URL;
		process.env.ROUTER_API_BASE = "https://my.router.dev/v1";
		expect(routerBaseUrl()).toBe("https://my.router.dev/v1");
	});

	it("strips trailing slash", () => {
		delete process.env.NINEROUTER_URL;
		process.env.ROUTER_API_BASE = "https://my.router.dev/v1/";
		expect(routerBaseUrl()).toBe("https://my.router.dev/v1");
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

	it("handles empty catalog gracefully", () => {
		expect(buildModelsDevIndex([]).size).toBe(0);
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

	it("finds by stripping provider prefix (router style: provider/model)", () => {
		expect(lookupInIndex("anthropic/claude-opus-4", index)?.name).toBe("Claude Opus 4");
	});

	it("finds with deep prefix e.g. cc/claude-opus-4", () => {
		expect(lookupInIndex("cc/claude-opus-4", index)?.name).toBe("Claude Opus 4");
	});

	it("finds with date suffix stripped", () => {
		expect(lookupInIndex("claude-sonnet-4-5-20250514", index)?.name).toBe("Claude Sonnet 4.5");
	});

	it("finds with provider prefix + date suffix", () => {
		expect(lookupInIndex("anthropic/claude-sonnet-4-5-20250514", index)?.name).toBe(
			"Claude Sonnet 4.5",
		);
	});

	it("returns undefined for unknown model", () => {
		expect(lookupInIndex("nonexistent-model-xyz", index)).toBeUndefined();
	});

	it("finds gpt-4o exact", () => {
		expect(lookupInIndex("gpt-4o", index)?.name).toBe("GPT-4o");
	});

	it("finds o3-mini exact", () => {
		expect(lookupInIndex("o3-mini", index)?.name).toBe("o3 mini");
	});
});
