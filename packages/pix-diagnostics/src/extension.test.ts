import { describe, expect, test } from "bun:test";
import registerExtension from "./extension.ts";

interface Handler {
	event: string;
	fn: (event: unknown, ctx: unknown) => unknown;
}

function mockPi() {
	const handlers: Handler[] = [];
	const tools: Array<{ name: string }> = [];
	const widgets: Array<{
		key: string;
		content?: unknown;
		options?: { placement?: "aboveEditor" | "belowEditor" };
	}> = [];
	const statuses: Array<{ key: string; value?: string }> = [];
	const pi = {
		on(event: string, fn: (e: unknown, c: unknown) => unknown) {
			handlers.push({ event, fn });
		},
		registerTool(def: { name: string }) {
			tools.push(def);
		},
		registerCommand() {},
	};
	const ctx = {
		ui: {
			setWidget(
				key: string,
				content?: unknown,
				options?: { placement?: "aboveEditor" | "belowEditor" },
			) {
				widgets.push({ key, content, options });
			},
			setStatus(key: string, value?: string) {
				statuses.push({ key, value });
			},
		},
	};
	return { pi, ctx, handlers, tools, widgets, statuses };
}

describe("pix-diagnostics extension", () => {
	test("registers exactly the three runtime tools and starts no process", () => {
		const m = mockPi();
		registerExtension(m.pi as never);
		expect(m.tools.map((t) => t.name)).toEqual([
			"lens_diagnostics",
			"lsp_navigation",
			"lens_diagnostic_mark",
		]);
	});

	test("uses an above-editor widget instead of the footer", () => {
		const m = mockPi();
		registerExtension(m.pi as never);
		const start = m.handlers.find((h) => h.event === "session_start");
		start?.fn({}, m.ctx);
		expect(m.widgets).toContainEqual({ key: "pi-lens-lsp", content: undefined });
		expect(m.statuses).toEqual([{ key: "pi-lens-lsp", value: undefined }]);
	});

	test("a failed write does not start a check or show the widget", async () => {
		const m = mockPi();
		registerExtension(m.pi as never);
		const start = m.handlers.find((h) => h.event === "session_start");
		start?.fn({}, m.ctx);

		const toolResult = m.handlers.find((h) => h.event === "tool_result");
		await toolResult?.fn(
			{ toolName: "write", input: { path: "/repo/a.ts" }, isError: true },
			m.ctx,
		);
		expect(m.widgets.at(-1)).toEqual({ key: "pi-lens-lsp", content: undefined });
		expect(m.statuses).toEqual([{ key: "pi-lens-lsp", value: undefined }]);
	});

	test("session_shutdown clears the widget and shuts down the manager", async () => {
		const m = mockPi();
		registerExtension(m.pi as never);
		const shutdown = m.handlers.find((h) => h.event === "session_shutdown");
		await shutdown?.fn({}, m.ctx);
		expect(m.widgets).toContainEqual({ key: "pi-lens-lsp", content: undefined });
		expect(m.statuses).toEqual([{ key: "pi-lens-lsp", value: undefined }]);
	});

	test("registering twice keeps one set of tools", () => {
		const m = mockPi();
		registerExtension(m.pi as never);
		registerExtension(m.pi as never);
		expect(m.tools.map((t) => t.name)).toEqual([
			"lens_diagnostics",
			"lsp_navigation",
			"lens_diagnostic_mark",
		]);
	});
});
