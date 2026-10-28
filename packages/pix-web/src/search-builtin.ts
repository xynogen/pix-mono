import { ioTimeoutSignal } from "@xynogen/pix-runtime/io";
import { searchConfig } from "./search-config.ts";
import type { SearchProvider, SearchRequest, SearchResultItem } from "./search-providers.ts";
import { registerSearchProvider } from "./search-providers.ts";

async function jsonResponse(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		...init,
		signal: ioTimeoutSignal(init?.signal ?? undefined),
	});
	if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 500)}`);
	return (await response.json()) as Record<string, unknown>;
}

function items(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function env(name: string): string {
	return process.env[name] ?? "";
}

/** Map raw items to the unified result shape, reading configurable field names. */
function normalize(
	values: Array<Record<string, unknown>>,
	fields: { url?: string; title?: string; snippet?: string; publishedAt?: string } = {},
): SearchResultItem[] {
	return values.map((item) => {
		const publishedAt = text(item[fields.publishedAt ?? "published_at"]);
		return {
			title: text(item[fields.title ?? "title"]),
			url: text(item[fields.url ?? "url"]),
			snippet: text(item[fields.snippet ?? "snippet"]),
			...(publishedAt ? { publishedAt } : {}),
		};
	});
}

// ── No API key ────────────────────────────────────────────────────────────

const searxng: SearchProvider = {
	id: "searxng",
	env: ["SEARXNG_URL"],
	isConfigured: () => Boolean(process.env.SEARXNG_URL),
	async search(request) {
		const query = new URLSearchParams({
			q: request.query,
			format: "json",
			categories: request.searchType === "news" ? "news" : "general",
		});
		const base = env("SEARXNG_URL").replace(/\/+$/, "");
		const endpoint = base.endsWith("/search") ? base : `${base}/search`;
		const data = await jsonResponse(`${endpoint}?${query}`, { signal: request.signal });
		return normalize(items(data.results), {
			snippet: "content",
			publishedAt: "publishedDate",
		}).slice(0, request.maxResults);
	},
};

// ── POST + bearer / x-api-key ───────────────────────────────────────────────

const exa: SearchProvider = {
	id: "exa",
	env: ["EXA_API_KEY"],
	isConfigured: () => Boolean(process.env.EXA_API_KEY),
	async search(request) {
		const data = await jsonResponse("https://api.exa.ai/search", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-api-key": env("EXA_API_KEY") },
			body: JSON.stringify({
				query: request.query,
				numResults: request.maxResults,
				type: "auto",
				text: true,
				highlights: true,
				...(request.searchType === "news" ? { category: "news" } : {}),
			}),
			signal: request.signal,
		});
		return items(data.results).map((item) => ({
			title: text(item.title),
			url: text(item.url),
			snippet: text(items(item.highlights)[0]) || text(item.text).slice(0, 300),
			...(text(item.publishedDate) ? { publishedAt: text(item.publishedDate) } : {}),
		}));
	},
};

const tavily: SearchProvider = {
	id: "tavily",
	env: ["TAVILY_API_KEY"],
	isConfigured: () => Boolean(process.env.TAVILY_API_KEY),
	async search(request) {
		const data = await jsonResponse("https://api.tavily.com/search", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env("TAVILY_API_KEY")}`,
			},
			body: JSON.stringify({
				query: request.query,
				max_results: request.maxResults,
				topic: request.searchType === "news" ? "news" : "general",
			}),
			signal: request.signal,
		});
		return normalize(items(data.results), { snippet: "content", publishedAt: "published_date" });
	},
};

const perplexity: SearchProvider = {
	id: "perplexity",
	env: ["PERPLEXITY_API_KEY"],
	isConfigured: () => Boolean(process.env.PERPLEXITY_API_KEY),
	async search(request) {
		const data = await jsonResponse("https://api.perplexity.ai/search", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env("PERPLEXITY_API_KEY")}`,
			},
			body: JSON.stringify({ query: request.query, max_results: request.maxResults }),
			signal: request.signal,
		});
		return normalize(items(data.results), { publishedAt: "date" });
	},
};

const serper: SearchProvider = {
	id: "serper",
	env: ["SERPER_API_KEY"],
	isConfigured: () => Boolean(process.env.SERPER_API_KEY),
	async search(request) {
		const endpoint = request.searchType === "news" ? "/news" : "/search";
		const data = await jsonResponse(`https://google.serper.dev${endpoint}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-API-Key": env("SERPER_API_KEY") },
			body: JSON.stringify({ q: request.query, num: request.maxResults }),
			signal: request.signal,
		});
		const list = items(request.searchType === "news" ? data.news : data.organic);
		return list.map((item) => ({
			title: text(item.title),
			url: text(item.link),
			snippet: text(item.snippet) || text(item.description),
			...(text(item.date) ? { publishedAt: text(item.date) } : {}),
		}));
	},
};

const linkup: SearchProvider = {
	id: "linkup",
	env: ["LINKUP_API_KEY"],
	isConfigured: () => Boolean(process.env.LINKUP_API_KEY),
	async search(request) {
		const data = await jsonResponse("https://api.linkup.so/v1/search", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env("LINKUP_API_KEY")}`,
			},
			body: JSON.stringify({
				q: request.query,
				depth: "standard",
				outputType: "searchResults",
				maxResults: request.maxResults,
			}),
			signal: request.signal,
		});
		return items(data.results).map((item) => ({
			title: text(item.name) || text(item.title),
			url: text(item.url),
			snippet: text(item.content) || text(item.snippet),
		}));
	},
};

// ── GET + header / query auth ───────────────────────────────────────────────

const braveSearch: SearchProvider = {
	id: "brave-search",
	env: ["BRAVE_API_KEY"],
	isConfigured: () => Boolean(process.env.BRAVE_API_KEY),
	async search(request) {
		const endpoint = request.searchType === "news" ? "/news/search" : "/web/search";
		const query = new URLSearchParams({ q: request.query, count: String(request.maxResults) });
		const data = await jsonResponse(`https://api.search.brave.com/res/v1${endpoint}?${query}`, {
			headers: { Accept: "application/json", "X-Subscription-Token": env("BRAVE_API_KEY") },
			signal: request.signal,
		});
		const container = request.searchType === "news" ? data.news || data : data.web;
		const list = items((container as Record<string, unknown> | undefined)?.results);
		return list.map((item) => ({
			title: text(item.title),
			url: text(item.url),
			snippet: text(item.description),
			...(text(item.page_age) ? { publishedAt: text(item.page_age) } : {}),
		}));
	},
};

const youcom: SearchProvider = {
	id: "youcom",
	env: ["YDC_API_KEY"],
	isConfigured: () => Boolean(process.env.YDC_API_KEY),
	async search(request) {
		const query = new URLSearchParams({
			query: request.query,
			count: String(Math.min(request.maxResults, 100)),
		});
		const data = await jsonResponse(`https://ydc-index.io/v1/search?${query}`, {
			headers: { Accept: "application/json", "X-API-Key": env("YDC_API_KEY") },
			signal: request.signal,
		});
		const result = data.results as Record<string, unknown> | undefined;
		const list = items(result?.[request.searchType]);
		return list.map((item) => ({
			title: text(item.title),
			url: text(item.url),
			snippet: text(items(item.snippets)[0]) || text(item.description),
			...(text(item.page_age) ? { publishedAt: text(item.page_age) } : {}),
		}));
	},
};

const googlePse: SearchProvider = {
	id: "google-pse",
	env: ["GOOGLE_PSE_API_KEY", "GOOGLE_PSE_CX"],
	isConfigured: () => Boolean(process.env.GOOGLE_PSE_API_KEY && process.env.GOOGLE_PSE_CX),
	async search(request) {
		const query = new URLSearchParams({
			key: env("GOOGLE_PSE_API_KEY"),
			cx: env("GOOGLE_PSE_CX"),
			q: request.query,
			num: String(Math.min(request.maxResults, 10)),
		});
		const data = await jsonResponse(`https://www.googleapis.com/customsearch/v1?${query}`, {
			headers: { Accept: "application/json" },
			signal: request.signal,
		});
		return normalize(items(data.items), { url: "link" });
	},
};

const searchapi: SearchProvider = {
	id: "searchapi",
	env: ["SEARCHAPI_API_KEY"],
	isConfigured: () => Boolean(process.env.SEARCHAPI_API_KEY),
	async search(request) {
		const query = new URLSearchParams({
			engine: request.searchType === "news" ? "google_news" : "google",
			q: request.query,
			api_key: env("SEARCHAPI_API_KEY"),
		});
		const data = await jsonResponse(`https://www.searchapi.io/api/v1/search?${query}`, {
			headers: { Accept: "application/json" },
			signal: request.signal,
		});
		const list = items(data.organic_results).length
			? items(data.organic_results)
			: items(data.top_stories);
		return list.map((item) => ({
			title: text(item.title),
			url: text(item.link),
			snippet: text(item.snippet) || text(item.description),
			...(text(item.date) ? { publishedAt: text(item.date) } : {}),
		}));
	},
};

const xquik: SearchProvider = {
	id: "xquik",
	env: ["XQUIK_API_KEY"],
	isConfigured: () => Boolean(process.env.XQUIK_API_KEY),
	async search(request) {
		const query = new URLSearchParams({ q: request.query, limit: String(request.maxResults) });
		const data = await jsonResponse(`https://xquik.com/api/v1/x/tweets/search?${query}`, {
			headers: { Accept: "application/json", "x-api-key": env("XQUIK_API_KEY") },
			signal: request.signal,
		});
		return items(data.tweets).map((item) => {
			const author = item.author as Record<string, unknown> | undefined;
			const username = text(author?.username);
			const id = text(item.id) || String(item.id ?? "");
			const url = username && id ? `https://x.com/${username}/status/${id}` : "";
			return {
				title: username ? `@${username} on X` : "X post",
				url,
				snippet: text(item.text),
				...(text(item.createdAt) ? { publishedAt: text(item.createdAt) } : {}),
			};
		});
	},
};

// ── Ollama Cloud web search (reuses the Ollama chat key) ─────────────────────

const ollamaSearch: SearchProvider = {
	id: "ollama-search",
	env: ["OLLAMA_API_KEY"],
	isConfigured: () => Boolean(process.env.OLLAMA_API_KEY),
	async search(request) {
		const data = await jsonResponse("https://ollama.com/api/web_search", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env("OLLAMA_API_KEY")}`,
			},
			body: JSON.stringify({ query: request.query, max_results: request.maxResults }),
			signal: request.signal,
		});
		return normalize(items(data.results), { snippet: "content", publishedAt: "published_at" });
	},
};

// ── GLM Coding plan web search (MCP JSON-RPC, reuses the z.ai chat key) ────

const glm: SearchProvider = {
	id: "glm",
	env: ["ZAI_API_KEY"],
	isConfigured: () => Boolean(process.env.ZAI_API_KEY),
	async search(request) {
		const data = await jsonResponse("https://api.z.ai/api/mcp/web_search_prime/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				Authorization: `Bearer ${env("ZAI_API_KEY")}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: `pix-${Date.now()}`,
				method: "tools/call",
				params: {
					name: "web_search_prime",
					arguments: { search_query: request.query, count: request.maxResults },
				},
			}),
			signal: request.signal,
		});
		// The MCP envelope carries the result list as JSON text in result.content[0].text.
		const result = data.result as { content?: Array<{ text?: unknown }> } | undefined;
		const raw = text(result?.content?.[0]?.text);
		let payload: unknown = data;
		if (raw) {
			try {
				payload = JSON.parse(raw);
			} catch {
				throw new Error(`glm returned non-JSON content: ${raw.slice(0, 200)}`);
			}
		}
		const record = payload as Record<string, unknown>;
		const list = Array.isArray(payload) ? items(payload) : items(record.results ?? record.news);
		return list.slice(0, request.maxResults).map((item) => ({
			title: text(item.title),
			url: text(item.link) || text(item.url),
			snippet: text(item.content),
			...(text(item.publish_date) ? { publishedAt: text(item.publish_date) } : {}),
		}));
	},
};

// ── 9Router aggregator (provider IS the model) ──────────────────────────────

/** Base URL from NINEROUTER_URL / ROUTER_API_BASE, with `/v1` appended. No default: an
 * unset URL means 9Router is not configured, so callers must not send a request. */
function routerBaseUrl(): string | undefined {
	const configured = (process.env.NINEROUTER_URL || process.env.ROUTER_API_BASE)?.trim();
	if (!configured) return undefined;
	const base = configured.replace(/\/+$/, "");
	return base.endsWith("/v1") ? base : `${base}/v1`;
}

const nineRouter: SearchProvider = {
	id: "9router",
	env: ["NINEROUTER_URL", "NINEROUTER_KEY"],
	isConfigured: () =>
		Boolean(routerBaseUrl() && (process.env.NINEROUTER_KEY || process.env.ROUTER_API_KEY)),
	async search(request: SearchRequest) {
		const key = process.env.NINEROUTER_KEY || process.env.ROUTER_API_KEY;
		const base = routerBaseUrl();
		if (!base) throw new Error("9Router is not configured: set NINEROUTER_URL");
		const data = await jsonResponse(`${base}/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(key ? { Authorization: `Bearer ${key}` } : {}),
			},
			body: JSON.stringify({
				model: searchConfig.nineRouterModel,
				query: request.query,
				search_type: request.searchType,
				max_results: request.maxResults,
			}),
			signal: request.signal,
		});
		return normalize(items(data.results));
	},
};

export function registerBuiltinSearchProviders(): void {
	for (const provider of [
		searxng,
		nineRouter,
		exa,
		tavily,
		perplexity,
		serper,
		linkup,
		braveSearch,
		youcom,
		googlePse,
		searchapi,
		xquik,
		ollamaSearch,
		glm,
	]) {
		registerSearchProvider(provider);
	}
}
