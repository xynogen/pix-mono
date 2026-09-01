/**
 * search.ts — search tool via 9Router API, with curl fallback.
 *
 * Environment:
 *   ROUTER_API_BASE  — router API base URL (default: https://9router.example.com/v1)
 *   ROUTER_API_KEY   — bearer token for the router
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { routerBaseUrl } from "./data.js";
import { apiPost, auth, curl, isCancelled } from "./http.js";
import { makeRenderCall, makeRenderResult } from "./render.js";

type RouterOutcome = "running" | "fallback" | "success" | "cancelled" | "error";
type SearchType = "web" | "news";

export interface SearchResultDetails {
	_type: "searchResult";
	outcome: RouterOutcome;
	query: string;
	searchType: SearchType;
	source?: "api" | "curl-fallback" | "failed";
	resultCount?: number;
}

export interface SearchParams {
	query: string;
	search_type?: SearchType;
	max_results?: number;
}

interface SearchResult {
	content: { type: "text"; text: string }[];
	details: SearchResultDetails;
	isError?: boolean;
}

interface SearchDependencies {
	apiPost: typeof apiPost;
	curl: typeof curl;
}

interface SearchResultItem {
	title?: string | null;
	url?: string | null;
	snippet?: string | null;
	published_at?: string | null;
	metadata?: { author?: string | null } | null;
	author?: string | null;
}

/** Parse and format a raw exa search response with its authoritative result count. */
export function parseSearchResults(raw: string): { text: string; count: number } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { text: raw.slice(0, 20_000), count: 0 };
	}

	const obj = parsed as Record<string, unknown>;
	const results = obj?.results;
	if (!Array.isArray(results)) {
		return { text: JSON.stringify(parsed, null, 2).slice(0, 20_000), count: 0 };
	}

	if (results.length === 0) return { text: "No results.", count: 0 };

	const lines: string[] = [];
	results.forEach((r: SearchResultItem, i: number) => {
		const title = (r.title ?? "").trim() || r.url || "(untitled)";
		lines.push(`${i + 1}. ${title}`);
		if (r.url) lines.push(`   ${r.url}`);
		const meta: string[] = [];
		const author = r.author ?? r.metadata?.author;
		if (author) meta.push(author);
		if (r.published_at) meta.push(r.published_at.slice(0, 10));
		if (meta.length > 0) lines.push(`   (${meta.join(" — ")})`);
		const snippet = (r.snippet ?? "").trim();
		if (snippet) lines.push(`   ${snippet.replace(/\s+/g, " ").slice(0, 300)}`);
		lines.push("");
	});

	return {
		text: lines.join("\n").trim().slice(0, 20_000),
		count: results.length,
	};
}

/** Format a raw exa search response as a compact markdown list. */
export function formatSearchResults(raw: string): string {
	return parseSearchResults(raw).text;
}

export async function executeSearch(
	params: SearchParams,
	signal?: AbortSignal,
	onUpdate?: (result: SearchResult) => void,
	dependencies: SearchDependencies = { apiPost, curl },
): Promise<SearchResult> {
	const max = Math.min(params.max_results ?? 5, 10);
	const searchType = params.search_type ?? "web";
	let apiMsg = "";

	try {
		onUpdate?.({
			content: [{ type: "text", text: `Searching (${searchType}): ${params.query}...` }],
			details: {
				_type: "searchResult",
				outcome: "running",
				query: params.query,
				searchType,
			},
		});

		const raw = await dependencies.apiPost(
			"/search",
			{
				model: "exa",
				query: params.query,
				search_type: searchType,
				max_results: max,
			},
			signal,
		);
		const parsed = parseSearchResults(raw);

		return {
			content: [{ type: "text", text: parsed.text }],
			details: {
				_type: "searchResult",
				outcome: "success",
				query: params.query,
				searchType,
				source: "api",
				resultCount: parsed.count,
			},
		};
	} catch (apiErr: unknown) {
		apiMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
		if (isCancelled(apiErr, signal)) {
			return {
				content: [{ type: "text", text: `Search cancelled.\nAPI: ${apiMsg}` }],
				details: {
					_type: "searchResult",
					outcome: "cancelled",
					query: params.query,
					searchType,
				},
			};
		}
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `API failed: ${apiMsg}\nFalling back to curl...`,
				},
			],
			details: {
				_type: "searchResult",
				outcome: "running",
				query: params.query,
				searchType,
			},
		});
	}

	try {
		const body = JSON.stringify({
			model: "exa",
			query: params.query,
			search_type: searchType,
			max_results: max,
		});
		const raw = await dependencies.curl([
			"-X",
			"POST",
			"-H",
			"Content-Type: application/json",
			...(auth() ? ["-H", `Authorization: Bearer ${auth()}`] : []),
			"-d",
			body,
			`${routerBaseUrl()}/search`,
		]);
		const parsed = parseSearchResults(raw);

		return {
			content: [
				{
					type: "text",
					text: `[FALLBACK — curl] API called via curl instead of fetch.\n\n${parsed.text.slice(0, 19_500)}`,
				},
			],
			details: {
				_type: "searchResult",
				outcome: "fallback",
				query: params.query,
				searchType,
				source: "curl-fallback",
				resultCount: parsed.count,
			},
		};
	} catch (curlErr: unknown) {
		const curlMsg = curlErr instanceof Error ? curlErr.message : String(curlErr);
		return {
			content: [
				{
					type: "text",
					text: `Search failed (both API and curl).\nAPI: ${apiMsg}\nCurl: ${curlMsg}`,
				},
			],
			details: {
				_type: "searchResult",
				outcome: "error",
				query: params.query,
				searchType,
				source: "failed",
			},
			isError: true,
		};
	}
}

export default function registerSearch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "search",
		label: "Search",
		renderShell: "self",
		description: "Web or news search via exa. Returns title, url, and snippet for each result.",
		promptSnippet:
			"search(query, search_type, max_results?) — search_type: 'web' or 'news'. Defaults to 5 results, max 10.",
		promptGuidelines: [
			"search: search_type='web' for general web results, 'news' for recent news articles.",
		],
		renderCall: makeRenderCall<unknown>("search", (args) =>
			String((args as Partial<SearchParams>).query ?? ""),
		),
		renderResult: (
			(renderTerminal) => (result, options, theme, context) =>
				renderTerminal(result, options, theme, {
					...context,
					isError: context.isError && options.expanded,
				})
		)(
			makeRenderResult<SearchResultDetails>({
				tool: "search",
				target: (details) => `“${details.query}”`,
				meta: (details) => {
					if (details.outcome === "error") return "failed";
					if (details.outcome === "cancelled") return "cancelled";
					const count = details.resultCount ?? 0;
					return `${count} ${count === 1 ? "result" : "results"} · ${details.searchType}`;
				},
				status: (details) =>
					details.outcome === "error"
						? "error"
						: details.outcome === "fallback" || details.outcome === "cancelled"
							? "warning"
							: "success",
			}),
		),
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			search_type: StringEnum(["web", "news"] as const, {
				description:
					'Required choice. Enter exactly "web" for general web results or "news" for recent news articles.',
			}),
			max_results: Type.Optional(
				Type.Number({
					description: "Max results (default 5, max 10)",
					default: 5,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			return executeSearch(params as SearchParams, signal, onUpdate);
		},
	});
}
