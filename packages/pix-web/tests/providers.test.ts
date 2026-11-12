import { describe, expect, test } from "bun:test";
import {
	getFetchProvider,
	listAllFetchProviders,
	listFetchProviders,
	registerFetchProvider,
} from "../src/providers.ts";
import { runFetch } from "../src/runner.ts";

describe("fetch provider registry", () => {
	test("registers a third-party provider", () => {
		registerFetchProvider({
			id: "test-provider",
			fetch: async ({ url }) => ({ url, content: "test" }),
		});
		expect(getFetchProvider("test-provider")?.id).toBe("test-provider");
		expect(listFetchProviders().map((provider) => provider.id)).toContain("test-provider");
	});

	test("listAllFetchProviders reports configured state, including unconfigured ones", () => {
		registerFetchProvider({
			id: "test-unconfigured",
			isConfigured: () => false,
			fetch: async ({ url }) => ({ url, content: "x" }),
		});
		const all = listAllFetchProviders();
		// Unconfigured providers are hidden from listFetchProviders but visible here.
		expect(listFetchProviders().map((p) => p.id)).not.toContain("test-unconfigured");
		expect(all.find((p) => p.id === "test-unconfigured")).toEqual({
			id: "test-unconfigured",
			configured: false,
			env: [],
		});
	});

	test("uses the next provider after a failure", async () => {
		registerFetchProvider({
			id: "test-fail",
			fetch: async () => {
				throw new Error("unavailable");
			},
		});
		registerFetchProvider({
			id: "test-success",
			fetch: async ({ url }) => ({ url, content: "Example" }),
		});
		const result = await runFetch(
			{ url: "https://example.com", format: "text", maxCharacters: 1000 },
			["test-fail", "test-success"],
		);
		expect(result.provider).toBe("test-success");
		expect(result.errors).toEqual([{ provider: "test-fail", message: "unavailable" }]);
	});
});
