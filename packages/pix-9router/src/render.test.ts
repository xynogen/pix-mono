import { expect, test } from "bun:test";
import { COLLAPSED_TOOL_GLYPH } from "@xynogen/pix-pretty/utils";
import { makeRenderCall, makeRenderResult } from "./render.js";

const theme = {
	fg: (t: string, s: string) => `[${t}]${s}`,
	bold: (s: string) => `*${s}*`,
} as never;

function stubComponent() {
	let captured = "";
	const component = {
		setText: (s: string) => {
			captured = s;
		},
		render: () => [],
		invalidate: () => {},
	};
	return { component, get: () => captured };
}

function context(stub: ReturnType<typeof stubComponent>, overrides: Record<string, unknown> = {}) {
	return {
		lastComponent: stub.component as never,
		isError: false,
		state: {},
		expanded: false,
		invalidate: () => {},
		...overrides,
	} as never;
}

const config = {
	tool: "fetch",
	target: (_details: { _type: "fetchResult"; chars: number }) => "https://example.com",
	meta: (details: { _type: "fetchResult"; chars: number }) => `${details.chars} chars`,
};

test("renderCall shows title + dim arg", () => {
	const stub = stubComponent();
	const rc = makeRenderCall<{ url: string }>("fetch", (a) => a.url);
	rc({ url: "https://x.com" }, theme, context(stub));
	// Only the tool name is accent/toolTitle-colored; the arg is secondary.
	expect(stub.get()).toBe("[toolTitle]*fetch* [dim]https://x.com");
});

test("renderCall hides only an effectively collapsed call row", () => {
	const stub = stubComponent();
	const rc = makeRenderCall<{ url: string }>("fetch", (a) => a.url);
	rc({ url: "https://x.com" }, theme, context(stub, { state: { collapsed: true } }));
	expect(stub.get()).toBe("");

	rc(
		{ url: "https://x.com" },
		theme,
		context(stub, { state: { collapsed: true }, expanded: true }),
	);
	expect(stub.get()).toBe("[toolTitle]*fetch* [dim]https://x.com");
});

test("renderResult renders structured compact details after collapse", () => {
	const stub = stubComponent();
	const rr = makeRenderResult(config);
	rr(
		{
			content: [{ type: "text", text: "full body" }],
			details: { _type: "fetchResult", chars: 9 },
		} as never,
		{ expanded: false, isPartial: false },
		theme,
		context(stub, { state: { collapsed: true } }),
	);
	expect(stub.get()).toContain("[success]✓");
	expect(stub.get()).toContain("https://example.com");
	expect(stub.get()).toContain("9 chars");
});

test("partial updates keep detail visible and do not schedule collapse", () => {
	const stub = stubComponent();
	const state: Record<string, unknown> = {};
	const rr = makeRenderResult(config);
	rr(
		{
			content: [{ type: "text", text: "streaming body" }],
			details: { _type: "fetchResult", chars: 14 },
		} as never,
		{ expanded: false, isPartial: true },
		theme,
		context(stub, { state }),
	);
	expect(stub.get()).toContain("streaming body");
	expect(state.timer).toBeUndefined();
});

test("expanded mode restores full joined text", () => {
	const stub = stubComponent();
	const rr = makeRenderResult(config);
	rr(
		{
			content: [
				{ type: "text", text: "first" },
				{ type: "image", data: "ignored", mimeType: "image/png" },
				{ type: "text", text: "second" },
			],
			details: { _type: "fetchResult", chars: 12 },
		} as never,
		{ expanded: true, isPartial: false },
		theme,
		context(stub, { state: { collapsed: true }, expanded: true }),
	);
	expect(stub.get()).toBe("  [dim]first\n  [dim]second");
});

test("renderResult caps the normal preview", () => {
	const stub = stubComponent();
	const rr = makeRenderResult(config);
	const body = Array.from({ length: 37 }, (_, i) => `L${i}`).join("\n");
	rr(
		{
			content: [{ type: "text", text: body }],
			details: { _type: "fetchResult", chars: body.length },
		} as never,
		{ expanded: false, isPartial: false },
		theme,
		context(stub, { state: { timer: 1 } }),
	);
	expect(stub.get()).toContain("… 5 more lines");
});

test("warning and error callbacks select shared status glyphs", () => {
	for (const [status, glyph] of [
		["warning", COLLAPSED_TOOL_GLYPH.warning],
		["error", COLLAPSED_TOOL_GLYPH.error],
	] as const) {
		const stub = stubComponent();
		const rr = makeRenderResult({ ...config, status: () => status });
		rr(
			{
				content: [{ type: "text", text: "body" }],
				details: { _type: "fetchResult", chars: 4 },
			} as never,
			{ expanded: false, isPartial: false },
			theme,
			context(stub, { state: { collapsed: true } }),
		);
		expect(stub.get()).toContain(`[${status}]${glyph}`);
	}
});

test("renderResult renders empty and errors without compacting", () => {
	const rr = makeRenderResult(config);
	const empty = stubComponent();
	rr(
		{ content: [{ type: "text", text: "   " }] } as never,
		{ expanded: false, isPartial: false },
		theme,
		context(empty),
	);
	expect(empty.get()).toBe("  [muted](empty)");

	const failed = stubComponent();
	rr(
		{ content: [{ type: "text", text: "boom" }] } as never,
		{ expanded: false, isPartial: false },
		theme,
		context(failed, { isError: true, state: { collapsed: true } }),
	);
	expect(failed.get()).toBe("  [error]boom");
});
