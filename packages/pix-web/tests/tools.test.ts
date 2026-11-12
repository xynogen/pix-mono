import { describe, expect, test } from "bun:test";
import { searchTool } from "../src/search-tool.ts";
import { fetchTool } from "../src/tools.ts";

const shape = (parameters: unknown) => {
	const schema = parameters as { properties: Record<string, unknown>; required?: string[] };
	return { properties: Object.keys(schema.properties), required: schema.required };
};

describe("web action schemas", () => {
	test("fetch keeps provider routing in user settings", () => {
		expect(shape(fetchTool().parameters)).toEqual({
			properties: ["url", "format", "max_characters"],
			required: ["url"],
		});
	});

	test("search keeps provider routing in user settings", () => {
		expect(shape(searchTool().parameters)).toEqual({
			properties: ["query", "search_type", "max_results"],
			required: ["query"],
		});
	});
});
