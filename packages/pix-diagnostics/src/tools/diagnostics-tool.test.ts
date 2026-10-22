import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { DiagnosticRequest, LspManager, NavigationResult } from "../lsp/manager.ts";
import { DiagnosticStore } from "../store.ts";
import type { DiagnosticSnapshot } from "../types.ts";
import { paintRow, registerDiagnosticsTool, renderClose } from "./diagnostics-tool.ts";

type ToolDef = {
	name: string;
	description: string;
	promptSnippet: string;
	parameters: { properties: Record<string, unknown> };
	execute: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: Array<{ text: string }>; isError?: boolean; details?: unknown }>;
};

function fakeManager(
	overrides: Partial<LspManager> = {},
): LspManager & { calls: DiagnosticRequest[] } {
	const calls: DiagnosticRequest[] = [];
	return {
		calls,
		async check(request: DiagnosticRequest): Promise<DiagnosticSnapshot[]> {
			calls.push(request);
			return request.paths.map((filePath) => ({
				filePath,
				diagnostics: [
					{
						filePath,
						severity: "error",
						message: "bad",
						line: 3,
						column: 4,
						code: 2304,
						source: "ts",
					},
				],
				checkedAt: 1,
				state: "findings",
			}));
		},
		async navigate(): Promise<NavigationResult[]> {
			return [];
		},
		activeServerIds: () => [],
		async shutdown() {},
		...overrides,
	};
}

function capture(store: DiagnosticStore, manager: LspManager, cwd = "/repo"): ToolDef {
	let tool: ToolDef | null = null;
	const pi = {
		registerTool(def: ToolDef) {
			tool = def;
		},
	} as never;
	registerDiagnosticsTool(pi, { store, manager, cwd });
	if (!tool) throw new Error("tool not registered");
	return tool;
}

describe("lsp_diagnostics tool", () => {
	test("has exactly the four public fields", () => {
		const tool = capture(new DiagnosticStore(), fakeManager());
		const { name, description, promptSnippet, parameters } = tool;
		expect(
			Buffer.byteLength(JSON.stringify({ name, description, promptSnippet, parameters })),
		).toBeLessThanOrEqual(750);
		expect(Object.keys(tool.parameters.properties)).toEqual([
			"source",
			"paths",
			"severity",
			"waitMs",
		]);
	});

	test("source=session returns cached data and starts no server", async () => {
		const store = new DiagnosticStore();
		store.set({
			filePath: "/repo/a.ts",
			checkedAt: 1,
			state: "findings",
			diagnostics: [
				{ filePath: "/repo/a.ts", severity: "error", message: "cached", line: 1, column: 1 },
			],
		});
		const manager = fakeManager();
		const tool = capture(store, manager);
		const result = await tool.execute("t", { source: "session" });
		expect(manager.calls).toHaveLength(0);
		expect(result.content[0]?.text).toContain("cached");
	});

	test("source=session with paths filters cached data", async () => {
		const store = new DiagnosticStore();
		store.set({ filePath: "/repo/a.ts", checkedAt: 1, state: "clean", diagnostics: [] });
		store.set({ filePath: "/repo/b.ts", checkedAt: 2, state: "clean", diagnostics: [] });
		const tool = capture(store, fakeManager());
		const result = await tool.execute("t", { source: "session", paths: ["/repo/a.ts"] });
		const details = result.details as { files: number };
		expect(details.files).toBe(1);
	});

	test("source=lsp calls manager.check once with canonical paths", async () => {
		const manager = fakeManager();
		const tool = capture(new DiagnosticStore(), manager);
		await tool.execute("t", { source: "lsp", paths: ["a.ts", "b.ts"] });
		expect(manager.calls).toHaveLength(1);
		expect(manager.calls[0]?.paths).toEqual([resolve("/repo/a.ts"), resolve("/repo/b.ts")]);
	});

	test("source=lsp without paths throws a validation error", async () => {
		const tool = capture(new DiagnosticStore(), fakeManager());
		await expect(tool.execute("t", { source: "lsp" })).rejects.toThrow(/paths/);
	});

	test("unavailable files expose their reason even alongside findings", async () => {
		const store = new DiagnosticStore();
		store.set({
			filePath: "/repo/main.py",
			checkedAt: 1,
			diagnostics: [],
			state: "unavailable",
			reason: "Configure .pi/lsp.json",
		});
		store.set({
			filePath: "/repo/a.ts",
			checkedAt: 1,
			state: "findings",
			diagnostics: [
				{ filePath: "/repo/a.ts", severity: "error", message: "bad", line: 1, column: 1 },
			],
		});
		const result = await capture(store, fakeManager()).execute("t", { source: "session" });
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ outcome: "error", unavailable: 1, findings: 1 });
		expect(result.content[0]?.text).toMatch(
			/a\.ts:1:1 error bad[\s\S]*main\.py: unavailable: Configure \.pi\/lsp\.json/,
		);
	});

	test("missing severity maps to all", async () => {
		const manager = fakeManager();
		const tool = capture(new DiagnosticStore(), manager);
		await tool.execute("t", { source: "lsp", paths: ["a.ts"] });
		expect(manager.calls[0]?.severity).toBe("all");
	});
});

describe("renderClose", () => {
	const theme = { fg: (role: string, text: string) => `[${role}]${text}[/${role}]` } as never;
	test("frames success and error, leaves partial unframed", () => {
		expect(renderClose("success", theme, 40)).toContain("[success]- - -");
		expect(renderClose("error", theme, 40)).toContain("[error]- - -");
		expect(renderClose("partial", theme, 40)).not.toContain("- - -");
	});
});

describe("result rows", () => {
	const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>` } as never;

	test("paint path dim, position muted, severity by role, message plain", () => {
		expect(paintRow("src/a.ts:3:4 error ts(2304) Cannot find name 'x'.", theme)).toBe(
			"<dim>src/a.ts</dim><muted>:3:4</muted> <error>error</error><muted> ts(2304)</muted> Cannot find name 'x'.",
		);
		expect(paintRow("README.md: unavailable: No server", theme)).toBe(
			"<dim>README.md</dim> <warning>unavailable</warning> <muted>No server</muted>",
		);
	});

	test("indent under the tool name and hang wrapped rows", () => {
		let tool: { renderResult: (...args: unknown[]) => { render(w: number): string[] } } | null =
			null;
		registerDiagnosticsTool({ registerTool: (def: never) => (tool = def) } as never, {
			store: new DiagnosticStore(),
			manager: fakeManager(),
			cwd: "/repo",
		});
		const plain = { fg: (_role: string, text: string) => text, bold: (t: string) => t };
		const text = `src/a.ts:1:1 error ts(1) ${"word ".repeat(20)}\nsrc/b.ts: unconfirmed: no reply`;
		const rows = tool!
			.renderResult(
				{ content: [{ type: "text", text }] },
				{ expanded: true, isPartial: true },
				plain,
				{ state: {}, expanded: true, invalidate() {} },
			)
			.render(40);
		const shape = rows.map(
			(row) => `${row.length - row.trimStart().length}:${row.trim().split(" ")[0]}`,
		);
		expect(shape[0]).toBe("3:src/a.ts:1:1");
		expect(shape.slice(1, -1).every((s) => s.startsWith("5:"))).toBe(true);
		expect(shape.at(-1)).toBe("3:src/b.ts");
	});
});
