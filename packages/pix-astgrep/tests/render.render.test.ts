import { expect, test } from "bun:test";
import { makeRenderCtx, makeTheme } from "@xynogen/pix-pretty/test-utils";
import { astCall, astResult } from "../src/render.ts";

const theme = makeTheme();

test("astCall hides the call row once its result has collapsed", () => {
	const call = astCall<{ path: string }>("outline", (args) => args.path);
	const open = call({ path: "src" }, theme, makeRenderCtx());
	expect(open.render(80).join("\n")).toContain("ast · outline src");
	const hidden = call({ path: "src" }, theme, makeRenderCtx({ state: { collapsed: true } }));
	expect(hidden.render(80).join("\n").trim()).toBe("");
});

test("astResult collapses a finished result to one row with the line count", () => {
	const render = astResult("search");
	const result = {
		content: [{ type: "text" as const, text: "a.ts:1\na.ts:2" }],
		details: undefined,
	};
	const row = render(
		result,
		{ expanded: false, isPartial: false },
		theme,
		makeRenderCtx({ isPartial: false, state: { collapsed: true } }),
	);
	expect(row.render(80).join("\n").trimEnd()).toMatchSnapshot();
});
