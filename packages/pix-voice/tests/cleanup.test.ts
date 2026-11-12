import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { cleanupModel, hasSlip, plausibleCleanup } from "../src/cleanup.ts";

describe("slip check before cleanup", () => {
	test.each([
		"i want 3 of it, no i meant 2",
		"um open the config",
		"open the the config",
		"rename it to bar, wait, to baz",
		"saya mau 3, eh bukan, maksudnya 2",
		"send it Monday, scratch that, Tuesday",
		"Sorry, I meant the second file",
	])("finds a slip in %j", (text) => {
		expect(hasSlip(text)).toBe(true);
	});

	test.each([
		"Open the package json and bump the version.",
		"Rename foo to baz in src/index.ts.",
		"Tolong buka file config.",
		"Know the nominal value",
	])("skips clean text %j", (text) => {
		expect(hasSlip(text)).toBe(false);
	});
});

const session = { provider: "p", id: "session" } as Model<Api>;
const other = { provider: "9router", id: "gpt-mini" } as Model<Api>;
const ctx = {
	model: session,
	modelRegistry: {
		find: (provider: string, id: string) =>
			provider === other.provider && id === other.id ? other : undefined,
	},
} as unknown as Parameters<typeof cleanupModel>[1];

describe("cleanup model setting", () => {
	test("off runs no cleanup, current uses the session model", () => {
		expect(cleanupModel("off", ctx)).toBeUndefined();
		expect(cleanupModel("current", ctx)).toBe(session);
	});

	test("provider/model finds the model, and splits on the first slash only", () => {
		expect(cleanupModel("9router/gpt-mini", ctx)).toBe(other);
	});

	test("an unknown or malformed model is an error, not a silent switch", () => {
		expect(() => cleanupModel("9router/nope", ctx)).toThrow(/not available/);
		expect(() => cleanupModel("gpt-mini", ctx)).toThrow(/not available/);
		expect(() => cleanupModel("current", { ...ctx, model: undefined })).toThrow(/no model/);
	});
});

describe("cleanup output check", () => {
	test("accepts a shorter or equal cleanup", () => {
		expect(plausibleCleanup("i want 3 of it, no i meant 2", "I want 2 of it.")).toBe(true);
		expect(plausibleCleanup("open the file", "Open the file.")).toBe(true);
	});

	test("rejects an empty result or an answer much longer than the dictation", () => {
		expect(plausibleCleanup("what is 2 plus 2", "")).toBe(false);
		expect(
			plausibleCleanup(
				"what is 2 plus 2",
				"2 plus 2 equals 4. In arithmetic, addition combines two numbers into a sum.",
			),
		).toBe(false);
	});
});
