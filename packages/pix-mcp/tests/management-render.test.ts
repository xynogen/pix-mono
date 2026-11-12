import { expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import { renderMcpProxyToolCall, renderMcpToolResult } from "../src/tool-result-renderer.ts";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const context = { state: {}, expanded: false, invalidate() {} };

test("management calls separate their action without changing direct tool labels", () => {
	for (const [args, action] of [
		[{}, "status"],
		[{ server: "demo" }, "list"],
		[{ search: "mesh" }, "search"],
		[{ describe: "mesh" }, "describe"],
		[{ connect: "demo" }, "connect"],
	] as const) {
		expect(renderMcpProxyToolCall(args, theme).render(100).join("\n")).toContain(`mcp · ${action}`);
	}
	expect(
		renderMcpProxyToolCall({ tool: "mesh", server: "demo" }, theme).render(100).join("\n"),
	).toContain("mcp mesh @ demo");
});

test("management previews show structured metadata and expansion retains source", async () => {
	const fixture = await withUiFixture();
	try {
		const source = "Full discovery text\nParameters:\nunique-schema-field";
		for (const details of [
			{
				mode: "status",
				servers: [{ name: "demo", status: "needs-auth", toolCount: 3 }],
				totalTools: 3,
			},
			{
				mode: "search",
				query: "mesh",
				count: 2,
				matches: [{ tool: "mesh", server: "demo" }],
				omitted: 1,
			},
			{ mode: "list", server: "demo", count: 1, tools: ["mesh"] },
			{ mode: "describe", server: "demo", tool: { name: "mesh", description: "Build a mesh" } },
		]) {
			const result = { content: [{ type: "text" as const, text: source }], details };
			const preview = stripTerminalSequences(
				renderMcpToolResult(result, { expanded: false, isPartial: false }, theme, context)
					.render(100)
					.join("\n"),
			);
			expect(preview).toContain(`mcp · ${details.mode}`);
			if (details.mode === "status") expect(preview).toContain("needs-auth");
			if (details.mode === "search") expect(preview).toContain("1 omitted by discovery limit");
			const full = stripTerminalSequences(
				renderMcpToolResult(result, { expanded: true, isPartial: false }, theme, {
					...context,
					expanded: true,
				})
					.render(100)
					.join("\n"),
			);
			expect(full).toContain("unique-schema-field");
			for (const [name, width, expanded, collapsed] of [
				["preview", 80, false, false],
				["narrow", 40, false, false],
				["expanded", 80, true, true],
				["collapsed", 80, false, true],
			] as const) {
				await fixture.runtime.update(collapseSection, { enabled: collapsed });
				const component = renderMcpToolResult(result, { expanded, isPartial: false }, roleTheme(), {
					state: { collapsed },
					expanded,
					invalidate() {},
				});
				if (collapsed && !expanded) expect(component.render(width)).toHaveLength(1);
				expect(captureRows(component, { width, surface: "host-self" })).toMatchSnapshot(
					`${details.mode} ${name}`,
				);
			}
			await fixture.runtime.update(collapseSection, { enabled: false });
		}
	} finally {
		await fixture.restore();
	}
});

test("management errors preserve actionable diagnostics", () => {
	const result = {
		content: [{ type: "text" as const, text: "Use mcp connect demo to retry" }],
		details: { mode: "list", error: "not_connected", server: "demo", tools: [] },
	};
	const rows = renderMcpToolResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(100)
		.join("\n");
	expect(rows).toContain("not_connected");
	expect(rows).toContain("Use mcp connect demo to retry");
});
