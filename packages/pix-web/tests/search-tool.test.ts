import { describe, expect, test } from "bun:test";
import { registerSearchTool } from "../src/search-tool.ts";

function captureParameters(): {
	properties: Record<string, unknown>;
	required?: string[];
} {
	let parameters: unknown;
	registerSearchTool({
		registerTool(tool: { parameters: unknown }) {
			parameters = tool.parameters;
		},
	} as never);
	if (!parameters) throw new Error("search parameters not captured");
	return parameters as { properties: Record<string, unknown>; required?: string[] };
}

describe("search tool schema", () => {
	test("keeps provider routing in user settings", () => {
		const parameters = captureParameters();
		expect({
			properties: Object.keys(parameters.properties),
			required: parameters.required,
		}).toEqual({
			properties: ["query", "search_type", "max_results"],
			required: ["query"],
		});
	});
});
