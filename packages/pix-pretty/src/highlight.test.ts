import { beforeEach, describe, expect, test } from "bun:test";
import { _cache, clearHighlightCache, hlBlock } from "./highlight.ts";

function theme(color: string) {
	return {
		fg: (key: string, text: string) => `\x1b[38;2;${color}m${key}:${text}\x1b[0m`,
		getFgAnsi: (key: string) => `\x1b[38;2;${color}m:${key}`,
	};
}

describe("active-theme syntax highlighting", () => {
	beforeEach(() => clearHighlightCache());

	test("maps JSON scopes to semantic Pi syntax roles", async () => {
		const out = (await hlBlock('{"name":"pix","count":2}', "json", theme("10;20;30"))).join("\n");
		expect(out).toContain("syntaxVariable");
		expect(out).toContain("syntaxString");
		expect(out).toContain("syntaxNumber");
	});

	test("separates cached output by active theme colors", async () => {
		await hlBlock("const value = 1", "typescript", theme("10;20;30"));
		await hlBlock("const value = 1", "typescript", theme("30;40;50"));
		expect(_cache.size).toBe(2);
	});

	test("bails to plain (never highlights) when any line exceeds the per-line guard", async () => {
		// Regression: a single multi-KB JSON string value made cli-highlight's
		// tokenizer backtrack and froze the render thread. The guard returns the
		// block unhighlighted (no ANSI, not cached) instead of tokenizing it.
		const mega = JSON.stringify({ blurb: "x".repeat(5000) });
		const out = await hlBlock(mega, "json", theme("10;20;30"));
		expect(out.join("\n")).toBe(mega); // untouched, no ANSI escapes injected
		expect(_cache.size).toBe(0); // not cached — it never went through highlight()
	});
});
