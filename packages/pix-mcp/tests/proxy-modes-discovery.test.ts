import { describe, expect, it } from "bun:test";
import { executeCall, executeSearch } from "../src/proxy-modes.ts";
import type { McpExtensionState } from "../src/state.ts";

// SDK v2 types content[0] as a TextContent | ImageContent union; narrow to text.
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	return first && first.type === "text" ? (first.text ?? "") : "";
}

function createState(): McpExtensionState {
	return {
		config: {
			mcpServers: {
				demo: { command: "npx", args: ["demo"] },
			},
		},
		toolMetadata: new Map([
			[
				"demo",
				[
					{
						name: "demo_search",
						originalName: "search",
						description: "Search demo records",
						inputSchema: { type: "object", properties: {} },
					},
				],
			],
		]),
		manager: {
			getConnection: () => undefined,
		},
		failureTracker: new Map(),
	} as unknown as McpExtensionState;
}

describe("proxy discovery", () => {
	it("searches MCP tools only", () => {
		const result = executeSearch(createState(), "read");

		expect(firstText(result)).toBe('No tools matching "read"');
		expect(result.details).toMatchObject({ count: 0, matches: [] });
	});

	it("rejects regex queries longer than the safety cap", () => {
		const result = executeSearch(createState(), "a".repeat(257), true);

		expect(result.details).toMatchObject({ error: "query_too_long", maxLength: 256 });
	});

	it("reports malformed regex queries separately from unsafe patterns", () => {
		const result = executeSearch(createState(), "[", true);

		expect(result.details).toMatchObject({ error: "invalid_pattern" });
	});

	it("rejects catastrophic-backtracking regex queries", () => {
		const result = executeSearch(createState(), "(a+)+$", true);

		expect(result.details).toMatchObject({ error: "unsafe_pattern", safetyStatus: "vulnerable" });
	});

	it("accepts safe regex queries", () => {
		const result = executeSearch(createState(), "^demo_[a-z]+$", true);

		expect(result.details).toMatchObject({ count: 1, returned: 1, query: "^demo_[a-z]+$" });
	});

	it("keeps non-regex searches unaffected by the regex length cap", () => {
		const result = executeSearch(createState(), "search terms ".repeat(40), false);

		expect(result.details).not.toMatchObject({ error: "query_too_long" });
	});

	it("tells callers to invoke native Pi tools directly", async () => {
		const result = await executeCall(createState(), "read", undefined, undefined, () => [
			{ name: "read", description: "Read a file" } as any,
		]);

		expect(firstText(result)).toBe(
			'"read" is a native Pi tool. Call read directly instead of using mcp({ tool: "read" }).',
		);
		expect(result.details).toMatchObject({ error: "native_tool", requestedTool: "read" });
	});
});
