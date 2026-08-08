import { describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import { resolveAddTargetPath } from "../src/config.ts";
import { type AddPanelCallbacks, McpAddPanel } from "../src/mcp-add-panel.ts";

const ENTER = "\r";

function panel() {
	const tui = { requestRender: mock(() => {}), terminal: { rows: 40 } };
	const callbacks: AddPanelCallbacks = {
		resolveTargetPath: () => "/tmp/mcp.json",
		previewEntry: () => ({
			path: "/tmp/mcp.json",
			existed: false,
			changed: true,
			beforeText: "",
			afterText: "{}",
			diffText: "",
		}),
		writeEntry: () => "/tmp/mcp.json",
		isNameTaken: () => false,
		testConnect: async () => "connected",
	};
	return new McpAddPanel({ cwd: "/tmp", callbacks }, tui, () => {});
}

function openRemoteUrlField(p: McpAddPanel): void {
	p.handleInput("\x1b[B");
	p.handleInput("\x1b[B");
	p.handleInput(ENTER);
	p.handleInput("\t");
}

describe("MCP add target", () => {
	it("writes global servers to Pi's agent mcp.json", () => {
		expect(resolveAddTargetPath("global", "/project", "/custom/agent/mcp.json")).toBe(
			"/custom/agent/mcp.json",
		);
		expect(resolveAddTargetPath("project", "/project", "/ignored/mcp.json")).toBe(
			join("/project", ".mcp.json"),
		);
	});
});

describe("MCP add text paste", () => {
	it("accepts a raw URL paste in one input event", () => {
		const p = panel();
		openRemoteUrlField(p);
		p.handleInput("https://example.com/mcp?x=1&y=2");
		expect(p.getFieldValue("url")).toBe("https://example.com/mcp?x=1&y=2");
		p.dispose();
	});

	it("buffers chunked bracketed paste and flattens line breaks", () => {
		const p = panel();
		openRemoteUrlField(p);
		p.handleInput("\x1b[200~https://example.com/");
		expect(p.getFieldValue("url")).toBe("");
		p.handleInput("mcp\n?token=x\x1b[201~");
		expect(p.getFieldValue("url")).toBe("https://example.com/mcp?token=x");
		p.dispose();
	});
});
