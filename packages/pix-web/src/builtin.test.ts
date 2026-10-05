import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as dns } from "node:dns";
import { registerBuiltinProviders } from "./builtin.ts";
import { fetchConfig } from "./config.ts";
import { getFetchProvider } from "./providers.ts";
import { fetchPublic } from "./public-url.ts";
import { htmlToText } from "./text.ts";

// ponytail: fixed public DNS keeps provider contract checks offline.
const lookup = spyOn(dns, "lookup").mockImplementation(
	async () => [{ address: "93.184.216.34", family: 4 }] as never,
);
afterAll(() => lookup.mockRestore());
const originalFetch = globalThis.fetch;
const originalTavilyKey = process.env.TAVILY_API_KEY;
const originalFirecrawlKey = process.env.FIRECRAWL_API_KEY;
const originalOllamaKey = process.env.OLLAMA_API_KEY;
const originalYoucomKey = process.env.YDC_API_KEY;
const originalNineRouterKey = process.env.NINEROUTER_KEY;
const originalLegacyRouterKey = process.env.ROUTER_API_KEY;
const originalNineRouterModel = fetchConfig.nineRouterModel;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
	else process.env.TAVILY_API_KEY = originalTavilyKey;
	if (originalFirecrawlKey === undefined) delete process.env.FIRECRAWL_API_KEY;
	else process.env.FIRECRAWL_API_KEY = originalFirecrawlKey;
	if (originalOllamaKey === undefined) delete process.env.OLLAMA_API_KEY;
	else process.env.OLLAMA_API_KEY = originalOllamaKey;
	if (originalYoucomKey === undefined) delete process.env.YDC_API_KEY;
	else process.env.YDC_API_KEY = originalYoucomKey;
	if (originalNineRouterKey === undefined) delete process.env.NINEROUTER_KEY;
	else process.env.NINEROUTER_KEY = originalNineRouterKey;
	if (originalLegacyRouterKey === undefined) delete process.env.ROUTER_API_KEY;
	else process.env.ROUTER_API_KEY = originalLegacyRouterKey;
	fetchConfig.nineRouterModel = originalNineRouterModel;
});

describe("built-in fetch providers", () => {
	test("requires a 9Router API key", () => {
		delete process.env.NINEROUTER_KEY;
		delete process.env.ROUTER_API_KEY;
		registerBuiltinProviders();
		expect(getFetchProvider("9router")?.isConfigured?.()).toBe(false);

		process.env.NINEROUTER_KEY = "router-key";
		expect(getFetchProvider("9router")?.isConfigured?.()).toBe(true);
	});

	test("uses the 9Router model from the standalone fetch config", async () => {
		fetchConfig.nineRouterModel = "selected-fetch";
		let sentModel: unknown;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			sentModel = JSON.parse(String(init?.body)).model;
			return Response.json({ url: "https://example.com", content: "Example" });
		}) as unknown as typeof fetch;
		registerBuiltinProviders();

		await getFetchProvider("9router")?.fetch({
			url: "https://example.com",
			format: "text",
			maxCharacters: 1000,
		});

		expect(sentModel).toBe("selected-fetch");
	});

	test("builds a Tavily request and normalizes its response", async () => {
		process.env.TAVILY_API_KEY = "tavily-key";
		let request: { url?: string; init?: RequestInit } = {};
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			request = { url: String(url), init };
			return new Response(
				JSON.stringify({
					results: [{ url: "https://example.com", raw_content: "<p>Example</p>" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;
		registerBuiltinProviders();

		const response = await getFetchProvider("tavily")?.fetch({
			url: "https://example.com",
			format: "markdown",
			maxCharacters: 1000,
		});

		expect(request.url).toBe("https://api.tavily.com/extract");
		expect(new Headers(request.init?.headers).get("authorization")).toBe("Bearer tavily-key");
		expect(response).toEqual({ url: "https://example.com", content: "Example" });
	});

	test("builds a Firecrawl request and normalizes its response", async () => {
		process.env.FIRECRAWL_API_KEY = "fc-key";
		let request: { url?: string; init?: RequestInit } = {};
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			request = { url: String(url), init };
			return Response.json({
				data: { markdown: "Example", metadata: { title: "Doc" } },
			});
		}) as unknown as typeof fetch;
		registerBuiltinProviders();

		const response = await getFetchProvider("firecrawl")?.fetch({
			url: "https://example.com",
			format: "markdown",
			maxCharacters: 1000,
		});

		expect(request.url).toBe("https://api.firecrawl.dev/v1/scrape");
		expect(new Headers(request.init?.headers).get("authorization")).toBe("Bearer fc-key");
		expect(response).toEqual({ title: "Doc", url: "https://example.com", content: "Example" });
	});

	test("builds an Ollama request and normalizes its response", async () => {
		process.env.OLLAMA_API_KEY = "ol-key";
		let request: { url?: string; init?: RequestInit } = {};
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			request = { url: String(url), init };
			return Response.json({ title: "Page", content: "Body text" });
		}) as unknown as typeof fetch;
		registerBuiltinProviders();

		const response = await getFetchProvider("ollama")?.fetch({
			url: "https://example.com",
			format: "markdown",
			maxCharacters: 1000,
		});

		expect(request.url).toBe("https://ollama.com/api/web_fetch");
		expect(response).toEqual({ title: "Page", url: "https://example.com", content: "Body text" });
	});

	test("builds a You.com request and normalizes its response", async () => {
		process.env.YDC_API_KEY = "youcom-key";
		let request: { url?: string; init?: RequestInit } = {};
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			request = { url: String(url), init };
			return Response.json([
				{ url: "https://example.com", title: "Example", markdown: "<p>Example</p>" },
			]);
		}) as unknown as typeof fetch;
		registerBuiltinProviders();

		const response = await getFetchProvider("youcom")?.fetch({
			url: "https://example.com",
			format: "markdown",
			maxCharacters: 1000,
		});

		expect(request.url).toBe("https://ydc-index.io/v1/contents");
		expect(new Headers(request.init?.headers).get("x-api-key")).toBe("youcom-key");
		expect(response).toEqual({
			title: "Example",
			url: "https://example.com",
			content: "Example",
		});
	});

	test("falls back to You.com html when markdown is missing", async () => {
		process.env.YDC_API_KEY = "youcom-key";
		globalThis.fetch = (async () =>
			Response.json([
				{ url: "https://example.com", html: "<p>Example</p>" },
			])) as unknown as typeof fetch;
		registerBuiltinProviders();

		const response = await getFetchProvider("youcom")?.fetch({
			url: "https://example.com",
			format: "text",
			maxCharacters: 1000,
		});

		expect(response?.content).toBe("Example");
	});

	test("blocks local addresses before an HTTP request", async () => {
		let requested = false;
		globalThis.fetch = (async () => {
			requested = true;
			return new Response();
		}) as unknown as typeof fetch;

		const error = await fetchPublic("http://127.0.0.1/private", {}).catch((cause) => cause);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Blocked URL: internal host");
		expect(requested).toBe(false);
	});

	test("uses the curl provider and strips page noise", async () => {
		globalThis.fetch = (async () =>
			new Response(
				"<html><head><title>Example</title><style>x{}</style></head><body><h1>Hello</h1><script>bad()</script><p>World &amp; all</p></body></html>",
				{ status: 200, headers: { "Content-Type": "text/html" } },
			)) as unknown as typeof fetch;
		registerBuiltinProviders();

		const response = await getFetchProvider("curl")?.fetch({
			url: "https://example.com",
			format: "text",
			maxCharacters: 1000,
		});

		expect(response).toEqual({
			title: "Example",
			url: "https://example.com",
			content: "Hello\nWorld & all",
		});
	});
});

describe("HTML text processing", () => {
	test("removes scripts, styles, comments, tags, and repeated space", () => {
		expect(
			htmlToText(
				"<!--x--><style>.x{}</style><p>One&nbsp; two</p><script>x()</script><div>Three</div>",
			),
		).toBe("One two\nThree");
	});
});
