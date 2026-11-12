import { describe, expect, test } from "bun:test";
import { DispositionStore } from "../../src/dispositions.ts";
import type { LspManager } from "../../src/lsp/manager.ts";
import { DiagnosticStore } from "../../src/store.ts";
import { lspTool } from "../../src/tools/lsp-tool.ts";

const theme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
} as never;
const manager = {
	check: async () => [],
	navigate: async () => [],
	activeServerIds: () => [],
	shutdown: async () => {},
} as LspManager;

type Renderer = {
	renderShell: string;
	renderCall: (
		args: unknown,
		theme: unknown,
		context: unknown,
	) => { render(width: number): string[] };
	renderResult: (
		result: unknown,
		options: unknown,
		theme: unknown,
		context: unknown,
	) => { render(width: number): string[] };
};

// The merged `lsp` tool routes rendering by `args.action`, as the host passes it.
const tool = lspTool({
	store: new DiagnosticStore(),
	dispositions: new DispositionStore(),
	manager,
	cwd: process.cwd(),
}) as Renderer;

describe("lsp tool collapse", () => {
	const cases = [
		{
			name: "lsp · diagnostics",
			args: { action: "diagnostics", source: "lsp", paths: ["a.ts"] },
			result: {
				content: [{ type: "text", text: "1 files, 0 clean, 1 unconfirmed" }],
				details: { outcome: "success", files: 1, findings: 0, unconfirmed: 1, unavailable: 0 },
			},
		},
		{
			name: "lsp · navigate",
			args: { action: "navigate", operation: "references", path: "a.ts" },
			result: {
				content: [{ type: "text", text: "a.ts:5:2\na.ts:9:3" }],
				details: { outcome: "success", operation: "references", results: 2, truncated: false },
			},
		},
		{
			name: "lsp · mark",
			args: { action: "mark", op: "list" },
			result: {
				content: [{ type: "text", text: "No dispositions." }],
				details: { outcome: "success", count: 0 },
			},
		},
	];

	for (const { name, args, result } of cases) {
		test(`${name} shows one summary, hides its call, and expands to the full result`, () => {
			expect(tool.renderShell).toBe("self");
			const state = { collapsed: true };
			const context = { args, state, expanded: false, isError: false, invalidate: () => {} };
			expect(tool.renderCall(args, theme, context).render(80).join("\n").trim()).toBe("");
			const collapsed = tool
				.renderResult(result, { isPartial: false }, theme, context)
				.render(80)
				.join("\n");
			expect(collapsed).toContain(name);
			expect(collapsed.split("\n")).toHaveLength(1);
			const expanded = tool
				.renderResult(result, { isPartial: false }, theme, { ...context, expanded: true })
				.render(80)
				.join("\n");
			for (const line of result.content[0]?.text.split("\n") ?? [])
				expect(expanded).toContain(line);
			expect(expanded.split("\n").length).toBeGreaterThan(1);
		});
	}
});
