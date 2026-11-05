import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import { Text } from "@earendil-works/pi-tui";
import { makeTheme } from "@xynogen/pix-pretty/test-utils";
import { frameToolResult, unframeToolResult } from "@xynogen/pix-pretty/utils";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { withUiFixture } from "../../../scripts/ui-capture.ts";
import { renderCall, renderResult } from "./codemode.ts";

let fixture: Awaited<ReturnType<typeof withUiFixture>>;
beforeAll(async () => {
	fixture = await withUiFixture();
});
afterAll(async () => {
	await fixture?.restore();
});

const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const options = { expanded: false, isPartial: false };

test("streaming arguments stay plain until execution starts, then highlight once", async () => {
	const theme = makeTheme({ tag: true });
	let invalidations = 0;
	const ctx = {
		state: {},
		expanded: false,
		executionStarted: false,
		invalidate: () => invalidations++,
	};
	for (const code of ["return", "return 1", "return 1;"]) {
		const component = renderCall({ code }, theme, ctx);
		const rows = component.render?.(80);
		expect(component.getText?.()).toEndWith(code);
		await Promise.resolve();
		expect(component.render?.(80)).toEqual(rows);
		expect(invalidations).toBe(0);
	}
	ctx.executionStarted = true;
	const component = renderCall({ code: "return 1;" }, theme, ctx);
	await Promise.resolve();
	expect(invalidations).toBe(1);
	expect(component.getText?.()).toEndWith("return 1;");
	renderCall({ code: "return 1;" }, theme, ctx);
	await Promise.resolve();
	expect(invalidations).toBe(1);
});

test("errors cancel collapse and restore the visible state", () => {
	const state = { collapsed: true, timer: setTimeout(() => {}, 60_000) };
	try {
		const theme = makeTheme();
		renderResult(result("Script error:\nbad input"), options, theme, {
			state,
			expanded: false,
			invalidate: () => {},
		});
		expect(state.collapsed).toBe(false);
		expect(state.timer).toBeUndefined();
	} finally {
		clearTimeout(state.timer);
	}
});

test("actual collapse schedules once and error cancels before expiry", async () => {
	await fixture.runtime.update(collapseSection, (current) => ({
		...current,
		enabled: true,
		delaySec: 1,
		tools: {},
	}));
	jest.useFakeTimers();
	const state: { collapsed?: boolean; timer?: ReturnType<typeof setTimeout> } = {};
	let invalidations = 0;
	const ctx = { state, expanded: false, invalidate: () => invalidations++ };
	try {
		renderResult(result("plain"), options, makeTheme(), ctx);
		const timer = state.timer;
		expect(timer).toBeDefined();
		renderResult(result("plain"), options, makeTheme(), ctx);
		expect(state.timer).toBe(timer);
		jest.advanceTimersByTime(1000);
		expect(state.collapsed).toBe(true);
		expect(invalidations).toBe(1);
		clearTimeout(state.timer);
		state.collapsed = false;
		state.timer = undefined;
		renderResult(result("plain"), options, makeTheme(), ctx);
		renderResult(result("Script error:\nbad"), options, makeTheme(), ctx);
		jest.advanceTimersByTime(1000);
		expect(state.collapsed).toBe(false);
		expect(invalidations).toBe(1);
	} finally {
		clearTimeout(state.timer);
		jest.useRealTimers();
		await fixture.runtime.update(collapseSection, (current) => ({
			...current,
			enabled: false,
			tools: {},
		}));
	}
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

test("reuses Text for wrapping previews and uses Text for expansion", () => {
	const theme = makeTheme();
	const previous = frameToolResult(new Text("old", 0, 0), theme, false);
	const context = { state: {}, expanded: false, invalidate: () => {}, lastComponent: previous };
	const preview = renderResult(result("plain"), options, theme, context);
	expect(unframeToolResult(preview)).toBe(unframeToolResult(previous));
	expect(preview.render?.(80)[0]).toMatch(/^plain +$/);
	const expanded = renderResult(result("plain"), { ...options, expanded: true }, theme, context);
	expect(unframeToolResult(expanded)).toBeInstanceOf(Text);
});
