import { ioTimeoutSignal } from "@xynogen/pix-runtime/io";
import { fetchConfig } from "./config.ts";
import type { FetchProvider, FetchRequest, FetchResponse } from "./providers.ts";
import { registerFetchProvider } from "./providers.ts";
import { fetchPublic } from "./public-url.ts";
import { htmlToText } from "./text.ts";

async function jsonRequest(
	url: string,
	apiKey: string,
	auth: "bearer" | "x-api-key",
	body: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(auth === "bearer" ? { Authorization: `Bearer ${apiKey}` } : { "x-api-key": apiKey }),
		},
		body: JSON.stringify(body),
		signal: ioTimeoutSignal(signal),
	});
	if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 500)}`);
	return response.json();
}

function plainText(content: string): string {
	return /<[a-z][\s\S]*>/i.test(content) ? htmlToText(content) : content.trim();
}

const exa: FetchProvider = {
	id: "exa",
	env: ["EXA_API_KEY"],
	isConfigured: () => Boolean(process.env.EXA_API_KEY),
	async fetch(request: FetchRequest): Promise<FetchResponse> {
		const data = (await jsonRequest(
			"https://api.exa.ai/contents",
			process.env.EXA_API_KEY ?? "",
			"x-api-key",
			{ ids: [request.url], text: true },
			request.signal,
		)) as { results?: Array<{ title?: string; url?: string; text?: string }> };
		const page = data.results?.[0];
		return {
			title: page?.title,
			url: page?.url || request.url,
			content: plainText(page?.text || ""),
		};
	},
};

const tavily: FetchProvider = {
	id: "tavily",
	env: ["TAVILY_API_KEY"],
	isConfigured: () => Boolean(process.env.TAVILY_API_KEY),
	async fetch(request: FetchRequest): Promise<FetchResponse> {
		const data = (await jsonRequest(
			"https://api.tavily.com/extract",
			process.env.TAVILY_API_KEY ?? "",
			"bearer",
			{
				urls: [request.url],
				extract_depth: "basic",
				format: request.format,
			},
			request.signal,
		)) as { results?: Array<{ url?: string; raw_content?: string }> };
		const page = data.results?.[0];
		return {
			url: page?.url || request.url,
			content: plainText(page?.raw_content || ""),
		};
	},
};

const firecrawl: FetchProvider = {
	id: "firecrawl",
	env: ["FIRECRAWL_API_KEY"],
	isConfigured: () => Boolean(process.env.FIRECRAWL_API_KEY),
	async fetch(request: FetchRequest): Promise<FetchResponse> {
		const data = (await jsonRequest(
			"https://api.firecrawl.dev/v1/scrape",
			process.env.FIRECRAWL_API_KEY ?? "",
			"bearer",
			{ url: request.url, formats: [request.format] },
			request.signal,
		)) as {
			data?: { markdown?: string; html?: string; text?: string; metadata?: { title?: string } };
		};
		const page = data.data;
		return {
			title: page?.metadata?.title,
			url: request.url,
			content: plainText(page?.markdown || page?.html || page?.text || ""),
		};
	},
};

// jina-reader returns text, not JSON, and works with or without a key.
const jinaReader: FetchProvider = {
	id: "jina-reader",
	env: ["JINA_API_KEY"],
	async fetch(request: FetchRequest): Promise<FetchResponse> {
		const key = process.env.JINA_API_KEY;
		const response = await fetch("https://r.jina.ai/", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(key ? { Authorization: `Bearer ${key}` } : {}),
			},
			body: JSON.stringify({ url: request.url }),
			signal: ioTimeoutSignal(request.signal),
		});
		if (!response.ok)
			throw new Error(`${response.status}: ${(await response.text()).slice(0, 500)}`);
		const body = await response.text();
		const title = body.match(/^\s*Title:\s*(.+)$/im)?.[1] || body.match(/^\s*#\s+(.+)$/m)?.[1];
		return { title: title?.trim(), url: request.url, content: plainText(body) };
	},
};

const ollama: FetchProvider = {
	id: "ollama",
	env: ["OLLAMA_API_KEY", "OLLAMA_URL"],
	isConfigured: () => Boolean(process.env.OLLAMA_API_KEY),
	async fetch(request: FetchRequest): Promise<FetchResponse> {
		const base = process.env.OLLAMA_URL || "https://ollama.com/api/web_fetch";
		const data = (await jsonRequest(
			base,
			process.env.OLLAMA_API_KEY ?? "",
			"bearer",
			{ url: request.url },
			request.signal,
		)) as { title?: string; content?: string };
		return { title: data.title, url: request.url, content: plainText(data.content || "") };
	},
};

const youcom: FetchProvider = {
	id: "youcom",
	env: ["YDC_API_KEY"],
	isConfigured: () => Boolean(process.env.YDC_API_KEY),
	async fetch(request: FetchRequest): Promise<FetchResponse> {
		const entries = (await jsonRequest(
			"https://ydc-index.io/v1/contents",
			process.env.YDC_API_KEY ?? "",
			"x-api-key",
			{ urls: [request.url], formats: ["markdown", "html"] },
			request.signal,
		)) as Array<{ url?: string; title?: string; html?: string | null; markdown?: string | null }>;
		const page = entries[0];
		return {
			title: page?.title,
			url: page?.url || request.url,
			content: plainText(page?.markdown || page?.html || ""),
		};
	},
};

/** Base URL from NINEROUTER_URL / ROUTER_API_BASE, with `/v1` appended. No default: an
 * unset URL means 9Router is not configured, so callers must not send a request. */
function routerBaseUrl(): string | undefined {
	const configured = (process.env.NINEROUTER_URL || process.env.ROUTER_API_BASE)?.trim();
	if (!configured) return undefined;
	const base = configured.replace(/\/+$/, "");
	return base.endsWith("/v1") ? base : `${base}/v1`;
}

function nineRouter(): FetchProvider {
	return {
		id: "9router",
		env: ["NINEROUTER_URL", "NINEROUTER_KEY"],
		isConfigured: () =>
			Boolean(routerBaseUrl() && (process.env.NINEROUTER_KEY || process.env.ROUTER_API_KEY)),
		async fetch(request: FetchRequest): Promise<FetchResponse> {
			const key = process.env.NINEROUTER_KEY || process.env.ROUTER_API_KEY;
			const base = routerBaseUrl();
			if (!base) throw new Error("9Router is not configured: set NINEROUTER_URL");
			const response = await fetch(`${base}/web/fetch`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(key ? { Authorization: `Bearer ${key}` } : {}),
				},
				body: JSON.stringify({
					model: fetchConfig.nineRouterModel,
					url: request.url,
					format: request.format,
					max_characters: request.maxCharacters,
				}),
				signal: ioTimeoutSignal(request.signal),
			});
			if (!response.ok)
				throw new Error(`${response.status}: ${(await response.text()).slice(0, 500)}`);
			const data = (await response.json()) as {
				title?: string;
				url?: string;
				content?: string | { text?: string };
			};
			const content = typeof data.content === "string" ? data.content : data.content?.text || "";
			return {
				title: data.title,
				url: data.url || request.url,
				content: plainText(content),
			};
		},
	};
}

const curl: FetchProvider = {
	id: "curl",
	async fetch(request: FetchRequest): Promise<FetchResponse> {
		const response = await fetchPublic(request.url, {
			headers: { Accept: "text/html, text/plain;q=0.9, */*;q=0.1" },
			redirect: "follow",
			signal: request.signal,
		});
		if (!response.ok)
			throw new Error(`${response.status}: ${(await response.text()).slice(0, 500)}`);
		const html = await response.text();
		const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
		return {
			title: title ? htmlToText(title) : undefined,
			url: response.url || request.url,
			content: htmlToText(html),
		};
	},
};

export function registerBuiltinProviders(): void {
	registerFetchProvider(exa);
	registerFetchProvider(tavily);
	registerFetchProvider(firecrawl);
	registerFetchProvider(jinaReader);
	registerFetchProvider(ollama);
	registerFetchProvider(youcom);
	registerFetchProvider(nineRouter());
	registerFetchProvider(curl);
}
