import { describe, expect, test } from "bun:test";
import { registerFetchTool } from "../src/tools.ts";

function captureParameters(): {
	properties: Record<string, unknown>;
	required?: string[];
} {
	let parameters: unknown;
	registerFetchTool({
		registerTool(tool: { parameters: unknown }) {
			parameters = tool.parameters;
		},
	} as never);
	if (!parameters) throw new Error("fetch parameters not captured");
	return parameters as { properties: Record<string, unknown>; required?: string[] };
}

describe("fetch tool schema", () => {
	test("keeps provider routing in user settings", () => {
		const parameters = captureParameters();
		expect({
			properties: Object.keys(parameters.properties),
			required: parameters.required,
		}).toEqual({
			properties: ["url", "format", "max_characters"],
			required: ["url"],
		});
	});
});
