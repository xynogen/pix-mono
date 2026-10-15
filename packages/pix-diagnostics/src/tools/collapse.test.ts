import { describe, expect, test } from "bun:test";
import { DispositionStore } from "../dispositions.ts";
import type { LspManager } from "../lsp/manager.ts";
import { DiagnosticStore } from "../store.ts";
import { registerDiagnosticsTool } from "./diagnostics-tool.ts";
import { registerMarkTool } from "./mark-tool.ts";
import { registerNavigationTool } from "./navigation-tool.ts";

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

function capture(register: (pi: never) => void): Renderer {
	let tool: Renderer | undefined;
	register({ registerTool: (definition: Renderer) => (tool = definition) } as never);
	if (!tool) throw new Error("tool not registered");
	return tool;
}

describe("diagnostics tool collapse", () => {
	const cases = [
		{
			name: "lsp_diagnostics",
			args: { source: "lsp", paths: ["a.ts"] },
			result: {
				content: [{ type: "text", text: "1 files, 0 clean, 1 unconfirmed" }],
				details: { outcome: "success", files: 1, findings: 0, unconfirmed: 1, unavailable: 0 },
			},
			register: (pi: never) =>
				registerDiagnosticsTool(pi, { store: new DiagnosticStore(), manager, cwd: process.cwd() }),
		},
		{
			name: "lsp_navigation",
			args: { operation: "references", path: "a.ts" },
			result: {
				content: [{ type: "text", text: "a.ts:5:2\na.ts:9:3" }],
				details: { outcome: "success", operation: "references", results: 2, truncated: false },
			},
			register: (pi: never) => registerNavigationTool(pi, { manager, cwd: process.cwd() }),
		},
		{
			name: "lsp_diagnostic_mark",
			args: { action: "list" },
			result: {
				content: [{ type: "text", text: "No dispositions." }],
				details: { outcome: "success", count: 0 },
			},
			register: (pi: never) =>
				registerMarkTool(pi, { store: new DispositionStore(), cwd: process.cwd() }),
		},
	];

	for (const { name, args, result, register } of cases) {
		test(`${name} shows one summary, hides its call, and expands to the full result`, () => {
			const tool = capture(register);
			expect(tool.renderShell).toBe("self");
			const state = { collapsed: true };
			const context = { state, expanded: false, isError: false, invalidate: () => {} };
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
