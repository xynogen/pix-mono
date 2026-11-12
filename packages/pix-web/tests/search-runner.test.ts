import { describe, expect, test } from "bun:test";
import { registerFetchProvider } from "../src/providers.ts";
import { runFetch } from "../src/runner.ts";
import { registerSearchProvider } from "../src/search-providers.ts";
import { runSearch } from "../src/search-runner.ts";

const request = { query: "Pi", searchType: "web" as const, maxResults: 5 };

describe("search runner", () => {
	test("uses the configured keyed provider before SearXNG", async () => {
		const calls: string[] = [];
		registerSearchProvider({
			id: "searxng",
			isConfigured: () => true,
			search: async () => {
				calls.push("searxng");
				return [];
			},
		});
		registerSearchProvider({
			id: "test-keyed-search",
			isConfigured: () => true,
			search: async () => {
				calls.push("test-keyed-search");
				return [];
			},
		});

		const result = await runSearch(request);

		expect({ provider: result.provider, calls }).toEqual({
			provider: "test-keyed-search",
			calls: ["test-keyed-search"],
		});
	});

	test("uses an explicit ordered fallback", async () => {
		registerSearchProvider({
			id: "test-search-fail",
			search: async () => {
				throw new Error("unavailable");
			},
		});
		registerSearchProvider({ id: "test-search-ok", search: async () => [] });

		const result = await runSearch(request, ["test-search-fail", "test-search-ok"]);

		expect({ provider: result.provider, errors: result.errors }).toEqual({
			provider: "test-search-ok",
			errors: [{ provider: "test-search-fail", message: "unavailable" }],
		});
	});
});

test("custom cancellation errors never trigger another search provider", async () => {
	const controller = new AbortController();
	const calls: string[] = [];
	registerSearchProvider({
		id: "cancel-search",
		search: async () => {
			calls.push("first");
			controller.abort(new Error("stop search"));
			throw new Error("transport closed");
		},
	});
	registerSearchProvider({
		id: "after-cancel-search",
		search: async () => {
			calls.push("second");
			return [];
		},
	});
	await expect(
		runSearch({ ...request, signal: controller.signal }, ["cancel-search", "after-cancel-search"]),
	).rejects.toThrow("stop search");
	expect(calls).toEqual(["first"]);
});

test("custom cancellation errors never trigger another fetch provider", async () => {
	const controller = new AbortController();
	const calls: string[] = [];
	registerFetchProvider({
		id: "cancel-fetch",
		fetch: async () => {
			calls.push("first");
			controller.abort(new Error("stop fetch"));
			throw new Error("transport closed");
		},
	});
	registerFetchProvider({
		id: "after-cancel-fetch",
		fetch: async () => {
			calls.push("second");
			return { url: "https://example.com", content: "unused" };
		},
	});
	await expect(
		runFetch(
			{ url: "https://example.com", format: "text", maxCharacters: 100, signal: controller.signal },
			["cancel-fetch", "after-cancel-fetch"],
		),
	).rejects.toThrow("stop fetch");
	expect(calls).toEqual(["first"]);
});
