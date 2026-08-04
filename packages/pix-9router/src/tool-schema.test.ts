import { describe, expect, test } from "bun:test";
import registerFetch from "./fetch.ts";
import registerSearch from "./search.ts";

function captureParameters(register: (pi: never) => void): {
	properties: Record<string, { type?: string; enum?: string[]; description?: string }>;
	required?: string[];
} {
	let parameters: unknown;
	register({
		registerTool(tool: { parameters: unknown }) {
			parameters = tool.parameters;
		},
	} as never);
	if (!parameters) throw new Error("tool parameters not captured");
	return parameters as {
		properties: Record<string, { type?: string; enum?: string[]; description?: string }>;
		required?: string[];
	};
}

describe("enum-like tool parameters", () => {
	test("search_type exposes values and their semantics", () => {
		const searchType = captureParameters(registerSearch).properties.search_type;
		if (!searchType) throw new Error("search_type schema not found");

		expect(searchType.type).toBe("string");
		expect(searchType.enum).toEqual(["web", "news"]);
		expect(searchType.description).toContain('exactly "web"');
		expect(searchType.description).toContain('"news"');
	});

	test("fetch format exposes values and their semantics", () => {
		const format = captureParameters(registerFetch).properties.format;
		if (!format) throw new Error("format schema not found");

		expect(format.type).toBe("string");
		expect(format.enum).toEqual(["markdown", "text", "html"]);
		expect(format.description).toContain('exactly "markdown"');
		expect(format.description).toContain('"html"');
	});
});

describe("fetch parameter requiredness", () => {
	test("only url is required; format is optional and defaults to markdown", () => {
		const params = captureParameters(registerFetch);

		// url must be required, format must NOT be — this is the exact validator
		// bug the optionality fix addresses (executeFetch already defaults format
		// to "markdown"), so guard against a regression back to a required format.
		expect(params.required).toEqual(["url"]);
		expect(params.required).not.toContain("format");

		// format stays a fully described enum in properties even while optional.
		const format = params.properties.format;
		if (!format) throw new Error("format schema not found");
		expect(format.enum).toEqual(["markdown", "text", "html"]);
		expect(format.description?.toLowerCase()).toContain("default");
	});
});
