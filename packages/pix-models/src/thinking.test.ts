import { describe, expect, it } from "bun:test";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { parseEfforts, withReasoningLevels } from "./thinking.ts";

const model = { provider: "9router", id: "cc/claude-opus-4-6", reasoning: true } as Model<Api>;
const entry = {
	provider: "anthropic",
	id: "claude-opus-4.6",
	levels: ["low", "medium", "high", "max"],
};

describe("models.dev reasoning levels", () => {
	it("parses only valid effort arrays from untrusted metadata", () => {
		expect(
			parseEfforts({
				anthropic: {
					models: {
						valid: { reasoning_options: [{ type: "effort", values: ["low", "high", "high"] }] },
						toggle: { reasoning_options: [{ type: "toggle" }] },
						invalid: { reasoning_options: [{ type: "effort", values: ["low", 1] }] },
					},
				},
			}),
		).toEqual([{ provider: "anthropic", id: "valid", levels: ["low", "high"] }]);
		expect(() => parseEfforts(null)).toThrow("Invalid models.dev catalog");
	});

	it("uses exact normalized model identity and exposes opt-in max without guessing xhigh", () => {
		const enriched = withReasoningLevels(model, [entry]);
		expect(getSupportedThinkingLevels(enriched)).toEqual(["low", "medium", "high", "max"]);
		expect(enriched.thinkingLevelMap?.max).toBe("max");
		expect(model.thinkingLevelMap).toBeUndefined();
	});

	it("prefers provider-specific metadata over conflicting gateway candidates", () => {
		const direct = { ...model, provider: "anthropic", id: entry.id };
		expect(
			getSupportedThinkingLevels(
				withReasoningLevels(direct, [entry, { ...entry, provider: "other", levels: ["low"] }]),
			),
		).toEqual(["low", "medium", "high", "max"]);
	});

	it("maps native min and none to Pi minimal and off", () => {
		const enriched = withReasoningLevels(model, [{ ...entry, levels: ["none", "min", "high"] }]);
		expect(getSupportedThinkingLevels(enriched)).toEqual(["off", "minimal", "high"]);
		expect(enriched.thinkingLevelMap).toMatchObject({ off: "none", minimal: "min" });
	});

	it("falls back unchanged for absent, ambiguous, unknown or empty levels", () => {
		for (const catalog of [
			[],
			[{ ...entry, id: "claude-opus-4" }],
			[entry, { ...entry, provider: "other", levels: ["high"] }],
			[{ ...entry, levels: ["ultra"] }],
			[{ ...entry, levels: [] }],
		]) {
			expect(withReasoningLevels(model, catalog)).toBe(model);
		}
	});

	it("preserves explicit provider maps and non-reasoning models", () => {
		for (const explicit of [
			{ ...model, thinkingLevelMap: { high: "custom" } },
			{ ...model, reasoning: false },
		]) {
			expect(withReasoningLevels(explicit, [entry])).toBe(explicit);
		}
	});
});
