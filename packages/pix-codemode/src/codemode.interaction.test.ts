import { afterAll, beforeAll, expect, test } from "bun:test";
import { Text } from "@earendil-works/pi-tui";
import { makeTheme } from "@xynogen/pix-pretty/test-utils";
import { frameToolResult, unframeToolResult } from "@xynogen/pix-pretty/utils";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { createIsolatedRuntime } from "@xynogen/pix-runtime/testing";
import { renderResult } from "./codemode.ts";

const fixture = createIsolatedRuntime();
const key = Symbol.for("@xynogen/pix-runtime");
const globals = globalThis as unknown as Record<symbol, unknown>;
const previous = globals[key];
beforeAll(async () => {
	globals[key] = fixture.runtime;
	await fixture.runtime.init();
	await fixture.runtime.update(collapseSection, { enabled: false });
});
afterAll(async () => {
	await fixture.runtime.shutdown();
	globals[key] = previous;
	fixture.cleanup();
});

const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const options = { expanded: false, isPartial: false };

test("errors cancel collapse and restore the visible state", () => {
	const state = { collapsed: true, timer: setTimeout(() => {}, 60_000) };
	const theme = makeTheme();
	renderResult(result("Script error:\nbad input"), options, theme, {
		state,
		expanded: false,
		invalidate: () => {},
	});
	expect(state.collapsed).toBe(false);
	expect(state.timer).toBeUndefined();
});

test("reuses a framed custom component and updates its body", () => {
	const theme = makeTheme();
	const inner = {
		value: "old",
		setText(value: string) {
			this.value = value;
		},
		render: () => [],
	};
	const previous = frameToolResult(inner, theme, false);
	const reused = renderResult(result("plain"), options, theme, {
		state: {},
		expanded: false,
		invalidate: () => {},
		lastComponent: previous,
	});
	expect(unframeToolResult(reused)).toBe(inner);
	expect(inner.value).toBe("plain");
});

test("replaces a previous Text preview with a viewport and uses Text for expansion", () => {
	const theme = makeTheme();
	const previous = frameToolResult(new Text("old", 0, 0), theme, false);
	const context = { state: {}, expanded: false, invalidate: () => {}, lastComponent: previous };
	const preview = renderResult(result("plain"), options, theme, context);
	expect(unframeToolResult(preview)).not.toBe(unframeToolResult(previous));
	expect(preview.render?.(80)[0]).toMatch(/^plain +$/);
	const expanded = renderResult(result("plain"), { ...options, expanded: true }, theme, context);
	expect(unframeToolResult(expanded)).toBeInstanceOf(Text);
});
