import { expect, test } from "bun:test";
import { buildAllowAttribute, getToolUiResourceUri } from "../src/ui-app-bridge-helpers.ts";

test("getToolUiResourceUri prefers the nested key, accepts the flat key, and rejects non-ui URIs", () => {
	expect(
		getToolUiResourceUri({ _meta: { ui: { resourceUri: "ui://a" }, "ui/resourceUri": "ui://b" } }),
	).toBe("ui://a");
	expect(getToolUiResourceUri({ _meta: { "ui/resourceUri": "ui://b" } })).toBe("ui://b");
	expect(getToolUiResourceUri({ _meta: { ui: "not an object" } })).toBeUndefined();
	expect(getToolUiResourceUri({})).toBeUndefined();
	expect(() => getToolUiResourceUri({ _meta: { ui: { resourceUri: "https://x" } } })).toThrow(
		"Invalid UI resource URI",
	);
});

test("buildAllowAttribute lists only granted permissions", () => {
	expect(buildAllowAttribute(undefined)).toBe("");
	expect(buildAllowAttribute({ camera: {}, clipboardWrite: {} })).toBe("camera; clipboard-write");
});
