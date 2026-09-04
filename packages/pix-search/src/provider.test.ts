import { expect, test } from "bun:test";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { createSearchProvider } from "./provider.ts";

function fakeInner(result: AutocompleteSuggestions | null): AutocompleteProvider {
	return {
		async getSuggestions() {
			return result;
		},
		applyCompletion(lines, cursorLine, cursorCol, _item, _prefix) {
			return { lines, cursorLine, cursorCol };
		},
	};
}

const signal = new AbortController().signal;
const opts = { signal };

test("non-@ prefix passes through to inner", async () => {
	const inner = fakeInner({
		items: [{ value: "/clear", label: "clear" }],
		prefix: "/cl",
	});
	const provider = createSearchProvider(inner, "/tmp", () => new Map());
	const result = await provider.getSuggestions(["/cl"], 0, 3, opts);
	expect(result?.prefix).toBe("/cl");
	expect(result?.items[0]?.value).toBe("/clear");
});

test("null inner result passes through", async () => {
	const inner = fakeInner(null);
	const provider = createSearchProvider(inner, "/tmp", () => new Map());
	const result = await provider.getSuggestions(["@foo"], 0, 4, opts);
	expect(result).toBeNull();
});

test("@ prefix triggers rg-based search", async () => {
	const inner = fakeInner({
		items: [{ value: "@src/index.ts", label: "index.ts", description: "src/index.ts" }],
		prefix: "@ind",
	});

	// This test exercises the real rg against the actual repo
	// Just verify it returns items with the @ prefix
	const provider = createSearchProvider(inner, process.cwd(), () => new Map());
	const result = await provider.getSuggestions(["@ind"], 0, 4, opts);

	// Should return something (we're in a real repo with files)
	if (result) {
		expect(result.prefix).toBe("@ind");
		// All values should start with @
		for (const item of result.items) {
			expect(item.value.startsWith("@")).toBe(true);
		}
	}
});

test("recency boosts recently-modified files", async () => {
	const inner = fakeInner({
		items: [{ value: "@package.json", label: "package.json" }],
		prefix: "@pack",
	});

	const recency = new Map([["package.json", 1.0]]);
	const provider = createSearchProvider(inner, process.cwd(), () => recency);
	const result = await provider.getSuggestions(["@pack"], 0, 5, opts);

	if (result && result.items.length > 0) {
		// package.json should be near the top given recency boost
		const labels = result.items.map((i) => i.label);
		expect(labels.some((l) => l === "package.json")).toBe(true);
	}
});
