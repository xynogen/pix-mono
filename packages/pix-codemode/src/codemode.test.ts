import { expect, test } from "bun:test";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capturePi } from "@xynogen/pix-pretty/test-utils";
import { renderCall, renderResult } from "./codemode.ts";
import extension from "./extension.ts";

test("extension wraps the enabled native tool only after session start", () => {
	const captured = capturePi();
	let start: (() => void) | undefined;
	Object.assign(captured.pi, {
		on: (event: string, handler: () => void) => {
			if (event === "session_start") start = handler;
		},
		getAllTools: () => [{ name: "codemode" }],
	});
	const native = capturePi();
	createCodemodeExtension()(native.pi as unknown as ExtensionAPI);
	extension(captured.pi as unknown as ExtensionAPI);
	expect(captured.names).toEqual([]);
	expect(typeof start).toBe("function");
	start?.();
	expect(captured.names).toEqual(["codemode"]);
	for (const key of Object.keys(native.tool)) {
		if (["renderCall", "renderResult", "execute", "prepareLoadout"].includes(key)) continue;
		expect(captured.tool[key]).toEqual(native.tool[key]);
	}
	expect(captured.tool.parameters).toBe(native.tool.parameters);
	expect(captured.tool.defaultActive).toBe(false);
	expect(captured.tool.renderCall === (renderCall as unknown)).toBe(true);
	expect(captured.tool.renderResult === (renderResult as unknown)).toBe(true);
	expect(captured.tool.renderShell).toBe("self");
	expect(typeof captured.tool.execute).toBe("function");
});

test("extension does not enable a disabled native codemode tool", () => {
	const captured = capturePi();
	let start: (() => void) | undefined;
	Object.assign(captured.pi, {
		on: (event: string, handler: () => void) => {
			if (event === "session_start") start = handler;
		},
		getAllTools: () => [],
	});
	extension(captured.pi as unknown as ExtensionAPI);
	start?.();
	expect(captured.names).toEqual([]);
});
