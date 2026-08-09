import { describe, expect, it } from "bun:test";
import { COLLAPSED_TOOL_GLYPH } from "@xynogen/pix-pretty/utils";
import registerFetch, { executeFetch, formatFetchResult } from "./fetch.ts";
import registerSearch, {
	executeSearch,
	formatSearchResults,
	parseSearchResults,
} from "./search.ts";

describe("formatSearchResults", () => {
	it("formats results as a numbered markdown list", () => {
		const raw = JSON.stringify({
			provider: "exa",
			query: "test",
			results: [
				{
					title: "First Result",
					url: "https://example.com/a",
					snippet: "Some   snippet\n  text here",
					published_at: "2026-03-04T22:36:57.000Z",
					metadata: { author: "alice" },
				},
				{
					title: "",
					url: "https://example.com/b",
					snippet: null,
				},
			],
		});

		const out = formatSearchResults(raw);
		expect(out).toContain("1. First Result");
		expect(out).toContain("   https://example.com/a");
		expect(out).toContain("(alice — 2026-03-04)");
		expect(out).toContain("Some snippet text here");
		// untitled result falls back to url as title
		expect(out).toContain("2. https://example.com/b");
		// no raw JSON noise
		expect(out).not.toContain("{");
		expect(out).not.toContain('"provider"');
	});

	it("handles empty results and reports the authoritative count", () => {
		expect(parseSearchResults(JSON.stringify({ results: [] }))).toEqual({
			text: "No results.",
			count: 0,
		});
		expect(formatSearchResults(JSON.stringify({ results: [] }))).toBe("No results.");
	});

	it("falls back to pretty JSON for unexpected shapes", () => {
		const raw = JSON.stringify({ answer: "42" });
		expect(formatSearchResults(raw)).toContain('"answer"');
	});

	it("returns raw string when not JSON", () => {
		expect(formatSearchResults("plain text error")).toBe("plain text error");
	});

	it("truncates long snippets to 300 chars", () => {
		const raw = JSON.stringify({
			results: [{ title: "T", url: "https://x.dev", snippet: "y".repeat(1000) }],
		});
		const out = formatSearchResults(raw);
		const snippetLine = out.split("\n").find((l) => l.trimStart().startsWith("yyy"));
		expect(snippetLine?.trim().length).toBe(300);
	});
});

describe("fetch execution metadata", () => {
	it("attaches API success metadata without changing returned content", async () => {
		const raw = JSON.stringify({
			url: "https://example.com",
			content: { text: "x".repeat(120) },
		});
		const originalContent = [
			{
				type: "text" as const,
				text: `URL: https://example.com\n\n${"x".repeat(120)}`,
			},
		];
		const result = await executeFetch(
			{ url: "https://example.com", format: "markdown", max_characters: 1000 },
			undefined,
			undefined,
			{
				apiPost: async () => raw,
				curl: async () => {
					throw new Error("curl should not run");
				},
			},
		);

		expect(result.details).toMatchObject({
			_type: "fetchResult",
			outcome: "success",
			url: "https://example.com",
			format: "markdown",
			source: "api",
			chars: 146,
		});
		expect(result.content).toEqual(originalContent);
	});

	it("defaults format to markdown when omitted (schema now optional)", async () => {
		let sentFormat: unknown;
		const raw = JSON.stringify({ url: "https://example.com", content: { text: "hello" } });
		const result = await executeFetch(
			// No `format` — valid now that the schema no longer requires it.
			{ url: "https://example.com" },
			undefined,
			undefined,
			{
				apiPost: async (_path, body) => {
					sentFormat = (body as { format?: unknown }).format;
					return raw;
				},
				curl: async () => {
					throw new Error("curl should not run");
				},
			},
		);

		// The default flows through to both the API request and the metadata.
		expect(sentFormat).toBe("markdown");
		expect(result.details).toMatchObject({ outcome: "success", format: "markdown" });
	});

	it("reports curl fallback metadata while preserving the fallback banner", async () => {
		const result = await executeFetch(
			{ url: "https://example.com", format: "html", max_characters: 1000 },
			undefined,
			undefined,
			{
				apiPost: async () => {
					throw new Error("API unavailable");
				},
				curl: async () => "<p>fallback</p>",
			},
		);

		expect(result.details).toMatchObject({
			_type: "fetchResult",
			outcome: "fallback",
			source: "curl-fallback",
			chars: 15,
		});
		expect(result.content[0]?.text).toContain("[FALLBACK — raw curl]");
	});

	it("returns a structured failure when both sources fail", async () => {
		const result = await executeFetch(
			{ url: "https://example.com", format: "text" },
			undefined,
			undefined,
			{
				apiPost: async () => {
					throw new Error("api boom");
				},
				curl: async () => {
					throw new Error("curl boom");
				},
			},
		);

		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			_type: "fetchResult",
			outcome: "error",
			source: "failed",
		});
		expect(result.content[0]?.text).toContain("API: api boom");
		expect(result.content[0]?.text).toContain("Curl: curl boom");
	});

	it("does not attempt curl after caller cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		let curlCalls = 0;
		const result = await executeFetch(
			{ url: "https://example.com", format: "markdown" },
			controller.signal,
			undefined,
			{
				apiPost: async () => {
					throw new DOMException("aborted", "AbortError");
				},
				curl: async () => {
					curlCalls++;
					return "unexpected";
				},
			},
		);

		expect(curlCalls).toBe(0);
		expect(result.details).toMatchObject({
			_type: "fetchResult",
			outcome: "cancelled",
		});
	});
});

describe("search execution metadata", () => {
	it("records API result count and preserves formatted content", async () => {
		const raw = JSON.stringify({
			results: [{ title: "One", url: "https://example.com/one" }],
		});
		const originalContent = [{ type: "text" as const, text: "1. One\n   https://example.com/one" }];
		const result = await executeSearch(
			{ query: "example", search_type: "web", max_results: 5 },
			undefined,
			undefined,
			{
				apiPost: async () => raw,
				curl: async () => {
					throw new Error("curl should not run");
				},
			},
		);

		expect(result.details).toMatchObject({
			_type: "searchResult",
			outcome: "success",
			query: "example",
			searchType: "web",
			source: "api",
			resultCount: 1,
		});
		expect(result.content).toEqual(originalContent);
	});

	it("records zero API results", async () => {
		const result = await executeSearch(
			{ query: "nothing", search_type: "news" },
			undefined,
			undefined,
			{
				apiPost: async () => '{"results":[]}',
				curl: async () => "",
			},
		);
		expect(result.content).toEqual([{ type: "text", text: "No results." }]);
		expect(result.details.resultCount).toBe(0);
	});

	it("records curl fallback count and banner", async () => {
		const result = await executeSearch(
			{ query: "fallback", search_type: "web" },
			undefined,
			undefined,
			{
				apiPost: async () => {
					throw new Error("api boom");
				},
				curl: async () => '{"results":[{"title":"A"},{"title":"B"}]}',
			},
		);
		expect(result.details).toMatchObject({
			outcome: "fallback",
			source: "curl-fallback",
			resultCount: 2,
		});
		expect(result.content[0]?.text).toContain("[FALLBACK — curl]");
	});

	it("reports both-source failure and skips fallback after abort", async () => {
		const failed = await executeSearch(
			{ query: "failure", search_type: "web" },
			undefined,
			undefined,
			{
				apiPost: async () => {
					throw new Error("api boom");
				},
				curl: async () => {
					throw new Error("curl boom");
				},
			},
		);
		expect(failed.isError).toBe(true);
		expect(failed.details).toMatchObject({ outcome: "error", source: "failed" });

		const controller = new AbortController();
		controller.abort();
		let curlCalls = 0;
		const cancelled = await executeSearch(
			{ query: "cancelled", search_type: "news" },
			controller.signal,
			undefined,
			{
				apiPost: async () => {
					throw new DOMException("aborted", "AbortError");
				},
				curl: async () => {
					curlCalls++;
					return "unexpected";
				},
			},
		);
		expect(curlCalls).toBe(0);
		expect(cancelled.details.outcome).toBe("cancelled");
	});
});

const renderTheme = {
	fg: (token: string, text: string) => `[${token}]${text}`,
	bold: (text: string) => `*${text}*`,
} as never;

function captureRegisteredTool(register: (pi: never) => void): Record<string, unknown> {
	let tool: Record<string, unknown> | undefined;
	register({
		registerTool(value: Record<string, unknown>) {
			tool = value;
		},
	} as never);
	if (!tool) throw new Error("tool was not registered");
	return tool;
}

function renderRegisteredResult(
	register: (pi: never) => void,
	result: Record<string, unknown>,
	expanded = false,
	isError = false,
): string {
	let tool: { renderResult?: (...args: never[]) => unknown } | undefined;
	register({
		registerTool(value: { renderResult?: (...args: never[]) => unknown }) {
			tool = value;
		},
	} as never);
	let text = "";
	const component = {
		setText(value: string) {
			text = value;
		},
		render: () => [],
		invalidate: () => {},
	};
	tool?.renderResult?.(result as never, { expanded, isPartial: false } as never, renderTheme, {
		lastComponent: component,
		isError,
		state: { collapsed: true },
		expanded,
		invalidate: () => {},
	} as never);
	return text;
}

describe("fetch and search compact renderers", () => {
	it("use the self-rendered shell so status marks have no leading box padding", () => {
		expect(captureRegisteredTool(registerFetch).renderShell).toBe("self");
		expect(captureRegisteredTool(registerSearch).renderShell).toBe("self");
	});

	it("renders fallback and failure rows from metadata", () => {
		const fetchRow = renderRegisteredResult(registerFetch, {
			content: [{ type: "text", text: "fallback body" }],
			details: {
				_type: "fetchResult",
				outcome: "fallback",
				url: "https://example.com",
				format: "markdown",
				source: "curl-fallback",
				chars: 120,
			},
		});
		expect(fetchRow).toContain(COLLAPSED_TOOL_GLYPH.warning);
		expect(fetchRow).toContain("120 chars · curl fallback");

		const searchRow = renderRegisteredResult(
			registerSearch,
			{
				content: [{ type: "text", text: "exact API and curl diagnostics" }],
				details: {
					_type: "searchResult",
					outcome: "error",
					query: "broken query",
					searchType: "web",
					source: "failed",
				},
			},
			false,
			true,
		);
		expect(searchRow).toContain("✗");
		expect(searchRow).toContain("“broken query”");
		expect(searchRow).toContain("failed");
	});

	it("restores exact failure diagnostics on expansion", () => {
		const diagnostic = "Search failed.\nAPI: unavailable\nCurl: exit 7";
		const output = renderRegisteredResult(
			registerSearch,
			{
				content: [{ type: "text", text: diagnostic }],
				details: {
					_type: "searchResult",
					outcome: "error",
					query: "broken query",
					searchType: "web",
					source: "failed",
				},
			},
			true,
			true,
		);
		expect(output).toContain("Search failed.");
		expect(output).toContain("API: unavailable");
		expect(output).toContain("Curl: exit 7");
	});
});

describe("formatFetchResult", () => {
	it("extracts content.text with title/url header", () => {
		const raw = JSON.stringify({
			provider: "exa",
			url: "https://example.com",
			title: "Example Page",
			content: { format: "markdown", text: "# Hello\n\nBody text." },
		});

		const out = formatFetchResult(raw);
		expect(out).toBe("# Example Page\nURL: https://example.com\n\n# Hello\n\nBody text.");
	});

	it("supports content as a plain string", () => {
		const raw = JSON.stringify({ content: "just text" });
		expect(formatFetchResult(raw)).toBe("just text");
	});

	it("returns raw when content.text is missing", () => {
		const raw = JSON.stringify({ status: "error" });
		expect(formatFetchResult(raw)).toBe(raw);
	});

	it("returns raw when not JSON", () => {
		expect(formatFetchResult("<html>raw</html>")).toBe("<html>raw</html>");
	});
});
