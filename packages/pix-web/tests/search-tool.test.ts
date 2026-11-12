import { describe, expect, test } from "bun:test";
import { webTool } from "../src/web-tool.ts";

describe("web tool schema", () => {
	test("is one flat object: action plus fetch and search fields, provider routing stays in settings", () => {
		const parameters = webTool().parameters as unknown as {
			type: string;
			properties: Record<string, { enum?: string[] }>;
			required?: string[];
		};
		expect({
			type: parameters.type,
			properties: Object.keys(parameters.properties),
			required: parameters.required,
			actions: parameters.properties.action?.enum,
		}).toEqual({
			type: "object",
			properties: [
				"action",
				"query",
				"search_type",
				"max_results",
				"url",
				"format",
				"max_characters",
			],
			required: ["action"],
			actions: ["search", "fetch"],
		});
	});

	test("a call missing the action's required field names it", async () => {
		await expect(
			webTool().execute("id", { action: "fetch" } as never, undefined, undefined, {} as never),
		).rejects.toThrow(/web fetch[\s\S]*url: missing/);
	});
});
