import { expect, mock, test } from "bun:test";

// Record whether anything imports "typescript". The real module is 9.1 MB and
// only `graph build` needs it, so loading the extension must not touch it.
let typescriptLoaded = false;
mock.module("typescript", () => {
	typescriptLoaded = true;
	return { default: {} };
});

test("loading the graph extension does not import typescript", async () => {
	const { default: registerGraph } = await import("./graph.ts");
	registerGraph({ registerTool() {}, registerCommand() {}, on() {} } as never);
	expect(typescriptLoaded).toBe(false);
});
