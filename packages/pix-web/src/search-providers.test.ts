import { afterEach, describe, expect, test } from "bun:test";
import { registerBuiltinSearchProviders } from "./search-builtin.ts";
import { searchConfig } from "./search-config.ts";
import { getSearchProvider, listAllSearchProviders } from "./search-providers.ts";

const originalFetch = globalThis.fetch;
const originalSearxngUrl = process.env.SEARXNG_URL;
const originalNineRouterKey = process.env.NINEROUTER_KEY;
const originalLegacyRouterKey = process.env.ROUTER_API_KEY;
const originalModel = searchConfig.nineRouterModel;
const originalNineRouterUrl = process.env.NINEROUTER_URL;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalSearxngUrl === undefined) delete process.env.SEARXNG_URL;
	else process.env.SEARXNG_URL = originalSearxngUrl;
	if (originalNineRouterKey === undefined) delete process.env.NINEROUTER_KEY;
	else process.env.NINEROUTER_KEY = originalNineRouterKey;
	if (originalLegacyRouterKey === undefined) delete process.env.ROUTER_API_KEY;
	else process.env.ROUTER_API_KEY = originalLegacyRouterKey;
	searchConfig.nineRouterModel = originalModel;
	if (originalNineRouterUrl === undefined) delete process.env.NINEROUTER_URL;
	else process.env.NINEROUTER_URL = originalNineRouterUrl;
});

describe("built-in search providers", () => {
	test("registers every direct provider from the 9Router blueprint", () => {
		registerBuiltinSearchProviders();
		const ids = new Set(listAllSearchProviders().map((provider) => provider.id));
		for (const id of [
			"searxng",
			"9router",
			"exa",
			"tavily",
			"youcom",
			"serper",
			"brave-search",
			"perplexity",
			"google-pse",
			"linkup",
			"searchapi",
			"xquik",
			"ollama-search",
			"glm",
		]) {
			expect(ids.has(id)).toBe(true);
		}
	});

	test("builds a Serper request and normalizes its response", async () => {
		process.env.SERPER_API_KEY = "serper-key";
		let captured: { url: string; body: Record<string, unknown>; headers: Headers } | undefined;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			captured = {
				url: String(url),
				body: JSON.parse(String(init?.body)),
				headers: new Headers(init?.headers),
			};
			return Response.json({
				organic: [{ title: "Pi", link: "https://example.com", snippet: "agent", date: "2024" }],
			});
		}) as unknown as typeof fetch;
		registerBuiltinSearchProviders();

		const result = await getSearchProvider("serper")?.search({
			query: "Pi",
			searchType: "web",
			maxResults: 3,
		});

		expect({
			endsWithSearch: captured?.url.endsWith("/search"),
			key: captured?.headers.get("x-api-key"),
			query: captured?.body.q,
			result,
		}).toEqual({
			endsWithSearch: true,
			key: "serper-key",
			query: "Pi",
			result: [{ title: "Pi", url: "https://example.com", snippet: "agent", publishedAt: "2024" }],
		});
		delete process.env.SERPER_API_KEY;
	});

	test("builds a Brave request and normalizes its response", async () => {
		process.env.BRAVE_API_KEY = "brave-key";
		let headers: Headers | undefined;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			headers = new Headers(init?.headers);
			return Response.json({
				web: { results: [{ title: "Pi", url: "https://example.com", description: "agent" }] },
			});
		}) as unknown as typeof fetch;
		registerBuiltinSearchProviders();

		const result = await getSearchProvider("brave-search")?.search({
			query: "Pi",
			searchType: "web",
			maxResults: 3,
		});

		expect({ token: headers?.get("x-subscription-token"), result }).toEqual({
			token: "brave-key",
			result: [{ title: "Pi", url: "https://example.com", snippet: "agent" }],
		});
		delete process.env.BRAVE_API_KEY;
	});

	test("builds a GLM MCP request and unwraps its text envelope", async () => {
		process.env.ZAI_API_KEY = "zai-key";
		let captured: { body: Record<string, unknown>; headers: Headers } | undefined;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			captured = { body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) };
			const hits = [
				{ title: "Pi", link: "https://example.com", content: "agent", publish_date: "2024" },
			];
			return Response.json({ result: { content: [{ type: "text", text: JSON.stringify(hits) }] } });
		}) as unknown as typeof fetch;
		registerBuiltinSearchProviders();

		const result = await getSearchProvider("glm")?.search({
			query: "Pi",
			searchType: "web",
			maxResults: 3,
		});

		expect({
			auth: captured?.headers.get("authorization"),
			method: captured?.body.method,
			params: captured?.body.params,
			result,
		}).toEqual({
			auth: "Bearer zai-key",
			method: "tools/call",
			params: { name: "web_search_prime", arguments: { search_query: "Pi", count: 3 } },
			result: [{ title: "Pi", url: "https://example.com", snippet: "agent", publishedAt: "2024" }],
		});
		delete process.env.ZAI_API_KEY;
	});

	test("offers SearXNG without an API key when its URL is set", () => {
		process.env.SEARXNG_URL = "https://search.example.com";
		registerBuiltinSearchProviders();
		expect(getSearchProvider("searxng")?.isConfigured?.()).toBe(true);
	});

	test("uses the separate 9Router search model", async () => {
		process.env.NINEROUTER_KEY = "router-key";
		process.env.NINEROUTER_URL = "https://router.test";
		searchConfig.nineRouterModel = "tavily";
		let body: Record<string, unknown> = {};
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return Response.json({ results: [] });
		}) as unknown as typeof fetch;
		registerBuiltinSearchProviders();

		await getSearchProvider("9router")?.search({
			query: "Pi coding agent",
			searchType: "web",
			maxResults: 5,
		});

		expect(body.model).toBe("tavily");
	});

	test("normalizes SearXNG search results", async () => {
		process.env.SEARXNG_URL = "https://search.example.com";
		globalThis.fetch = (async () =>
			Response.json({
				results: [{ title: "Pi", url: "https://example.com", content: "Coding agent" }],
			})) as unknown as typeof fetch;
		registerBuiltinSearchProviders();

		const result = await getSearchProvider("searxng")?.search({
			query: "Pi coding agent",
			searchType: "web",
			maxResults: 5,
		});

		expect(result).toEqual([{ title: "Pi", url: "https://example.com", snippet: "Coding agent" }]);
	});
});
