import { expect, test } from "bun:test";
import type { ModelRegistry } from "../src/model-resolver.ts";
import { listAvailable, resolveModel } from "../src/model-resolver.ts";

const registry = {
	find: (p: string, id: string) => ({ provider: p, id, name: id }),
	getAll: () => [
		{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
		{
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
		},
	],
} as unknown as ModelRegistry;

test("exact provider/id resolves", () => {
	const m = resolveModel("anthropic/claude-haiku-4-5", registry);
	expect(typeof m).not.toBe("string");
	expect((m as { id: string }).id).toBe("claude-haiku-4-5");
});

test("fuzzy 'haiku' resolves to the haiku model", () => {
	const m = resolveModel("haiku", registry);
	expect((m as { id: string }).id).toBe("claude-haiku-4-5");
});

test("no match returns an error string listing available models", () => {
	const r = resolveModel("gpt-9", registry);
	expect(typeof r).toBe("string");
	expect(r as string).toContain("anthropic/claude-haiku-4-5");
});

// ── listAvailable enrichment ────────────────────────────────────────────────
// Bench/dev data comes from the shared pix-data cache (non-deterministic across
// machines), so assertions target structure that holds regardless of cache
// contents: scope, id presence, and line shape.

const scoped = {
	find: () => null,
	getAll: () => [
		{ provider: "a", id: "in-catalog", name: "x" },
		{ provider: "a", id: "also-catalog", name: "y" },
		{ provider: "a", id: "available-only", name: "z" },
	],
	getAvailable: () => [{ provider: "a", id: "available-only", name: "z" }],
} as unknown as ModelRegistry;

test("listAvailable scopes to getAvailable, not the full catalog", () => {
	const lines = listAvailable(scoped);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("a/available-only");
	expect(lines.join("\n")).not.toContain("in-catalog");
});

test("listAvailable falls back to getAll when getAvailable is absent", () => {
	const lines = listAvailable(registry);
	expect(lines).toHaveLength(2);
	expect(lines.join("\n")).toContain("anthropic/claude-haiku-4-5");
});

test("each line at minimum carries the provider/id", () => {
	for (const line of listAvailable(registry)) {
		expect(line).toMatch(/^anthropic\//);
	}
});
