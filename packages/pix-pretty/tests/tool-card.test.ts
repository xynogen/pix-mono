import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { MockTextComponent, makeRenderCtx, makeTheme } from "../src/test-utils.ts";
import { toolCallRenderer, toolCardRenderer } from "../src/tool-card.ts";
import type { TextComponentCtor, ToolResultLike } from "../src/types.ts";

// SAFETY: MockTextComponent covers setText/getText/render, all the card uses.
const Text = MockTextComponent as unknown as TextComponentCtor;
type D = { _type: "demo"; n: number };

const card = toolCardRenderer<D>(Text, {
	name: "demo",
	owns: (d) => d?._type === "demo",
	collapsed: (d) => ({ target: "src", summary: `${d?.n ?? 0} items` }),
	body({ text, d }) {
		text.setText(`body ${d?.n}`);
		return undefined;
	},
});

const result = (details?: D, text = "boom"): ToolResultLike<D> => ({
	content: [{ type: "text", text }],
	details,
});
const render = (
	r: ToolResultLike<D>,
	{ isPartial = false, isError = false, collapsed = false, expanded = false } = {},
) => {
	const out = card(
		r,
		{ isPartial },
		makeTheme(),
		makeRenderCtx({ isError, expanded, state: { collapsed } }),
	);
	return stripVTControlCharacters(out.render?.(80).join("\n") ?? "");
};

describe("toolCardRenderer", () => {
	it("frames the body on success, leaves it bare while partial", () => {
		expect(render(result({ _type: "demo", n: 2 }))).toMatch(/body 2[\s\S]*─/);
		expect(render(result({ _type: "demo", n: 2 }), { isPartial: true })).toBe("body 2");
	});

	it("shows a foreign error at once, even when collapsed", () => {
		const out = render(result(undefined), { isError: true, collapsed: true });
		expect(out).toContain("boom");
		expect(out).not.toContain("demo");
	});

	it("collapses to one row with the summary, or failed for an owned error", () => {
		expect(render(result({ _type: "demo", n: 3 }), { collapsed: true })).toMatch(
			/demo src · 3 items/,
		);
		expect(render(result({ _type: "demo", n: 3 }), { isError: true, collapsed: true })).toMatch(
			/demo src · failed/,
		);
	});

	it("expands an owned error to the error text, not the body", () => {
		const out = render(result({ _type: "demo", n: 3 }), { isError: true });
		expect(out).toContain("boom");
		expect(out).not.toContain("body");
	});
});

describe("toolCallRenderer", () => {
	const call = toolCallRenderer<{ path: string }>(Text, (args) => `demo ${args.path}`);
	it("renders the line, and hides it once the result collapsed", () => {
		expect(call({ path: "a" }, makeTheme(), makeRenderCtx()).getText?.()).toBe("demo a");
		const hidden = makeRenderCtx({ state: { collapsed: true } });
		expect(call({ path: "a" }, makeTheme(), hidden).getText?.()).toBe("");
	});
});
