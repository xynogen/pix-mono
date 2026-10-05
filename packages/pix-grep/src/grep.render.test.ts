import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { capturePi, makeRenderCtx, makeToolContext } from "@xynogen/pix-pretty/test-utils";
import type { GrepResultDetails, ToolResultLike } from "@xynogen/pix-pretty/types";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, semanticRow, withUiFixture } from "../../../scripts/ui-capture.ts";

const theme = roleTheme();
let isolated: Awaited<ReturnType<typeof withUiFixture>>;
let tool: ReturnType<typeof capturePi>["tool"];

beforeAll(async () => {
	isolated = await withUiFixture();
	try {
		// Import config consumers only after the isolated fixture is ready.
		const { registerGrepTool } = await import("./grep");
		const { viewportTextConstructor } = await import("@xynogen/pix-pretty/utils");
		const captured = capturePi();
		tool = captured.tool;
		registerGrepTool(
			captured.pi,
			() => ({
				execute: async () => {
					throw new Error("UI tests must not execute search tools");
				},
			}),
			makeToolContext({
				cwd: "/fixture/project",
				sp: (path) => path,
				TextComponent: viewportTextConstructor(Text),
			}),
		);
	} catch (error) {
		await isolated.restore();
		throw error;
	}
});

afterAll(async () => {
	await isolated?.restore();
});

function result(text: string, pattern = "TODO", matchCount = 2): ToolResultLike<GrepResultDetails> {
	return {
		content: [{ type: "text", text }],
		details: { _type: "grepResult", text, pattern, path: "src", matchCount },
	};
}

async function capture(
	fixture: ToolResultLike<GrepResultDetails>,
	{ width = 80, collapsed = false, expanded = false, isError = false, isPartial = false } = {},
) {
	isolated.setWidth(width);
	await isolated.runtime.update(collapseSection, (current) => ({
		...current,
		enabled: collapsed,
		tools: {},
	}));
	const state = { collapsed };
	const context = makeRenderCtx({
		state,
		expanded,
		isError,
		invalidate: () => {
			throw new Error("UI capture must not schedule invalidation");
		},
	});
	const component = tool.renderResult?.(fixture, { isPartial }, theme, context);
	if (!component) throw new Error("Missing grep result renderer");
	const rows = component.render(width);
	for (const row of rows) expect(visibleWidth(row)).toBe(width);
	expect(state).toEqual({ collapsed });
	return {
		rows: captureRows(component, { width, surface: "component" }),
		plain: rows.map(stripVTControlCharacters),
	};
}

function expectClose(rows: string[], role: "success" | "error", width = 80) {
	expect(rows.at(-1)).toMatch(
		new RegExp(`^<${role}>(?:- ){${Math.floor(width / 2)}}<\\/${role}>$`),
	);
}

describe("grep UI", () => {
	const hits = "src/a.ts:1:TODO one\nsrc/b.ts:2:TODO two";

	it("captures the call title, target, path and glob roles", () => {
		isolated.setWidth(80);
		const component = tool.renderCall?.(
			{ pattern: "TODO", path: "src", glob: "*.ts" },
			theme,
			makeRenderCtx({ state: { collapsed: false } }),
		);
		if (!component) throw new Error("Missing grep call renderer");
		const rows = component.render(80);
		expect(rows.map(visibleWidth)).toEqual([80]);
		expect(rows.map(semanticRow)).toMatchSnapshot();
	});
	it("captures a single hit with a full-width success close", async () => {
		const { rows } = await capture(result("src/a.ts:1:TODO one", "TODO", 1));
		expectClose(rows, "success");
		expect(rows).toMatchSnapshot();
	});
	it("captures multiple hits in order with the same success shape", async () => {
		const { rows } = await capture(result(hits));
		expectClose(rows, "success");
		expect(rows).toMatchSnapshot();
	});
	it("captures the unframed collapsed summary", async () => {
		const { rows } = await capture(result(hits), { collapsed: true });
		expect(rows).toHaveLength(1);
		expect(rows).toMatchSnapshot();
	});
	it("restores both complete hits when the collapsed card is expanded", async () => {
		const { rows, plain } = await capture(result(hits), { collapsed: true, expanded: true });
		expect(plain.slice(0, 2)).toEqual(hits.split("\n").map((line) => `   ${line}`.padEnd(80)));
		expectClose(rows, "success");
		expect(rows).toMatchSnapshot();
	});
	it("captures a structured error, its collapsed summary and its expanded diagnostic", async () => {
		const diagnostic = "regex parse error: unclosed group";
		const fixture = result(diagnostic, "(", 0);
		const normal = await capture(fixture, { isError: true });
		const collapsed = await capture(fixture, { isError: true, collapsed: true });
		const expanded = await capture(fixture, { isError: true, collapsed: true, expanded: true });
		for (const output of [normal, expanded]) {
			expect(output.plain[0]).toBe(diagnostic.padEnd(80));
			expectClose(output.rows, "error");
		}
		expect(collapsed.rows).toHaveLength(1);
		expect({
			normal: normal.rows,
			collapsed: collapsed.rows,
			expanded: expanded.rows,
		}).toMatchSnapshot();
	});
	it("captures a partial result without a completed close", async () => {
		const { rows } = await capture(result(hits), { isPartial: true, collapsed: true });
		expect(rows).toHaveLength(2);
		expect(rows).toMatchSnapshot();
	});
	it("captures no matches and batch sections", async () => {
		expect((await capture(result("No matches found", "TODO", 0))).rows).toMatchSnapshot(
			"no matches",
		);
		expect(
			(await capture(result("===== foo =====\nsrc/a.ts:1:foo\n\n===== bar =====\nsrc/b.ts:2:bar")))
				.rows,
		).toMatchSnapshot("batch");
	});
	for (const width of [80, 120]) {
		it(`captures long output at ${width} columns without a mock wrapping shortcut`, async () => {
			const longHit = `src/long.ts:42:TODO ${"detail ".repeat(18)}END`;
			const { rows, plain } = await capture(result(`${longHit}\n\n  src/b.ts:2:TODO two`), {
				width,
				expanded: true,
			});
			// Grep fits to the terminal before Text renders. This locks its actual truncation contract.
			expect(plain[0]).toBe(`   ${longHit}`.slice(0, width));
			expect(plain[1]).toBe(" ".repeat(width));
			expect(plain[2]).toBe("     src/b.ts:2:TODO two".padEnd(width));
			expectClose(rows, "success", width);
			expect(rows).toMatchSnapshot();
		});
	}
});
