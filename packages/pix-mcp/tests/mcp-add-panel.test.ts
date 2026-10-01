import { describe, expect, it, mock } from "bun:test";
import { resolve } from "node:path";
import { resolveAddTargetPath } from "../src/config.ts";
import {
	type AddPanelCallbacks,
	type EditPanelOptions,
	McpAddPanel,
} from "../src/mcp-add-panel.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";

function stripAnsi(input: string): string {
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

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
	p.handleInput(DOWN);
	p.handleInput(ENTER);
	p.handleInput("\t");
}

function editPanel() {
	const tui = { requestRender: mock(() => {}), terminal: { rows: 40 } };
	const callbacks: AddPanelCallbacks = {
		resolveTargetPath: () => "/tmp/ignored.json",
		previewEntry: () => ({
			path: "/project/.mcp.json",
			existed: true,
			changed: true,
			beforeText: "{}",
			afterText: "{}",
			diffText: "",
		}),
		writeEntry: () => "/project/.mcp.json",
		isNameTaken: () => true,
		testConnect: async () => "connected",
	};
	return new McpAddPanel(
		{
			cwd: "/project",
			callbacks,
			edit: {
				name: "github",
				targetPath: "/project/.mcp.json",
				entry: { url: "https://api.githubcopilot.com/mcp", bearerTokenEnv: "GITHUB_TOKEN" },
			},
		},
		tui,
		() => {},
	);
}

describe("MCP add target", () => {
	it("writes global servers to Pi's agent mcp.json", () => {
		expect(resolveAddTargetPath("global", "/project", "/custom/agent/mcp.json")).toBe(
			resolve("/custom/agent/mcp.json"),
		);
		expect(resolveAddTargetPath("project", "/project", "/ignored/mcp.json")).toBe(
			resolve("/project", ".mcp.json"),
		);
	});
});

describe("MCP direct-tools opt-in toggle", () => {
	const SPACE = " ";

	function captureEntry(toggleValue: string, exposeResources?: string) {
		let captured: unknown;
		const tui = { requestRender: mock(() => {}), terminal: { rows: 40 } };
		const callbacks: AddPanelCallbacks = {
			resolveTargetPath: () => "/tmp/mcp.json",
			previewEntry: (_p, _n, entry) => {
				captured = entry;
				return {
					path: "/tmp/mcp.json",
					existed: false,
					changed: true,
					beforeText: "",
					afterText: "{}",
					diffText: "",
				};
			},
			writeEntry: () => "/tmp/mcp.json",
			isNameTaken: () => false,
			testConnect: async () => "connected",
		};
		const p = new McpAddPanel({ cwd: "/tmp", callbacks }, tui, () => {});
		p.handleInput(ENTER); // pickType -> form (stdio)
		p.setFieldValue("name", "srv");
		p.setFieldValue("command", "npx");
		p.setFieldValue("directTools", toggleValue); // "true" | "" as the toggle would leave it
		if (exposeResources !== undefined) p.setFieldValue("exposeResources", exposeResources);
		p.handleInput(ENTER); // form -> pickScope
		p.handleInput(ENTER); // pickScope -> preview (fires previewEntry)
		p.dispose();
		return captured as { directTools?: unknown; exposeResources?: unknown };
	}

	it("keeps resource tools off by default and writes true only when on", () => {
		expect(captureEntry("").exposeResources).toBeUndefined();
		expect(captureEntry("", "true").exposeResources).toBe(true);
	});

	it("opts in to all tools when the toggle is on", () => {
		expect(captureEntry("true").directTools).toBe(true);
	});

	it("leaves directTools undefined when the toggle is off", () => {
		expect(captureEntry("").directTools).toBeUndefined();
	});

	it("flips with space, ignores typing, and renders on/off", () => {
		const p = panel();
		p.handleInput(ENTER); // stdio form; directTools is the last field
		for (let i = 0; i < 8; i++) {
			if (stripAnsi(p.render(120).join("\n")).includes("\u25b6 Direct tools")) break;
			p.handleInput("\t");
		}
		expect(stripAnsi(p.render(120).join("\n"))).toContain("Direct tools: [ ] off");
		p.handleInput(SPACE);
		expect(p.getFieldValue("directTools")).toBe("true");
		expect(stripAnsi(p.render(120).join("\n"))).toContain("Direct tools: [x] on");
		p.handleInput("x"); // typing ignored on a toggle
		expect(p.getFieldValue("directTools")).toBe("true");
		p.handleInput(SPACE); // back off
		expect(p.getFieldValue("directTools")).toBe("");
		p.dispose();
	});

	it("collapses a config-only array allow-list to on in the edit form", () => {
		const tui = { requestRender: mock(() => {}), terminal: { rows: 40 } };
		const callbacks: AddPanelCallbacks = {
			resolveTargetPath: () => "/tmp/x.json",
			previewEntry: () => ({
				path: "/tmp/x.json",
				existed: true,
				changed: true,
				beforeText: "{}",
				afterText: "{}",
				diffText: "",
			}),
			writeEntry: () => "/tmp/x.json",
			isNameTaken: () => true,
			testConnect: async () => "connected",
		};
		const p = new McpAddPanel(
			{
				cwd: "/tmp",
				callbacks,
				edit: {
					name: "srv",
					targetPath: "/tmp/x.json",
					entry: { command: "npx", directTools: ["a"], exposeResources: true },
				},
			},
			tui,
			() => {},
		);
		expect(p.getFieldValue("directTools")).toBe("true");
		expect(p.getFieldValue("exposeResources")).toBe("true");
		expect(stripAnsi(p.render(120).join("\n"))).toContain("Resource tools: [x] on");
		p.dispose();
	});
});

describe("MCP add transport choices", () => {
	it("offers only MCP stdio and URL transports", () => {
		const output = stripAnsi(panel().render(120).join("\n"));

		expect(output).toContain("stdio / CLI");
		expect(output).toContain("URL / HTTP");
		expect(output).not.toContain("npx package");
		expect(output).not.toContain("SSE transport");
	});

	it("shows concrete examples for complex fields", () => {
		const p = panel();
		p.handleInput(ENTER);
		let output = stripAnsi(p.render(120).join("\n"));
		expect(output).toContain('Args: ["-y","@scope/server"] — JSON array');
		expect(output).toContain('Env: {"API_KEY":"$API_KEY"} — JSON object');

		p.handleInput("\x1b");
		p.handleInput(DOWN);
		p.handleInput(ENTER);
		output = stripAnsi(p.render(120).join("\n"));
		expect(output).toContain('Headers: {"X-API-Key":"$API_KEY"} — JSON object');
		expect(output).toContain("Token env: GITHUB_TOKEN — env var name");
		p.dispose();
	});
});

describe("MCP edit form", () => {
	it("opens prefilled and previews against original config path", () => {
		const p = editPanel();
		expect(p.getStep()).toBe("form");
		expect(p.getSelectedType()).toBe("http");
		expect(p.getFieldValue("name")).toBe("github");
		expect(p.getFieldValue("url")).toBe("https://api.githubcopilot.com/mcp");
		expect(p.getFieldValue("bearerTokenEnv")).toBe("GITHUB_TOKEN");
		expect(stripAnsi(p.render(120).join("\n"))).toContain("Edit MCP server");
		p.dispose();
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

describe("MCP add panel Pi fields", () => {
	function run(
		values: Record<string, string>,
		entry?: EditPanelOptions,
	): {
		p: McpAddPanel;
		written: unknown[];
		connects: string[];
		results: unknown[];
	} {
		const written: unknown[] = [];
		const connects: string[] = [];
		const results: unknown[] = [];
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
			writeEntry: (_path, _name, e) => {
				written.push(e);
				return "/tmp/mcp.json";
			},
			isNameTaken: () => entry !== undefined,
			testConnect: async (name) => {
				connects.push(name);
				return "connected";
			},
		};
		const p = new McpAddPanel({ cwd: "/tmp", callbacks, edit: entry }, tui, (r) => {
			results.push(r);
		});
		if (!entry) p.handleInput(ENTER); // pickType -> stdio form
		for (const [key, value] of Object.entries(values)) p.setFieldValue(key, value);
		p.handleInput(ENTER); // form -> pickScope (add) or preview (edit)
		if (!entry) p.handleInput(ENTER); // pickScope -> preview
		p.handleInput(ENTER); // preview -> write
		return { p, written, connects, results };
	}

	it("writes description, timeout, and enabled:false, and skips the connection test", () => {
		const { p, written, connects, results } = run({
			name: "srv",
			command: "npx",
			description: "  Docs search  ",
			timeout: "2.5",
			disabled: "true",
		});
		expect(written).toEqual([
			expect.objectContaining({ description: "Docs search", timeout: 2.5, enabled: false }),
		]);
		expect(connects).toEqual([]);
		expect(results).toEqual([expect.objectContaining({ connectStatus: "disabled" })]);
		p.dispose();
	});

	it("removes unset fields and tests the connection of an enabled server", async () => {
		const { p, written, connects } = run(
			{ description: "", timeout: "", disabled: "" },
			{
				name: "srv",
				targetPath: "/tmp/mcp.json",
				entry: { command: "npx", description: "old", timeout: 9, enabled: false },
			},
		);
		expect(p.getFieldValue("command")).toBe("npx");
		expect(written).toEqual([
			expect.objectContaining({ description: undefined, timeout: undefined, enabled: undefined }),
		]);
		await Promise.resolve();
		expect(connects).toEqual(["srv"]);
		p.dispose();
	});

	it("prefills the fields when it edits a server", () => {
		const tui = { requestRender: mock(() => {}), terminal: { rows: 40 } };
		const p = new McpAddPanel(
			{
				cwd: "/tmp",
				callbacks: {
					resolveTargetPath: () => "/tmp/x.json",
					previewEntry: () => {
						throw new Error("unused");
					},
					writeEntry: () => "/tmp/x.json",
					isNameTaken: () => true,
					testConnect: async () => "connected",
				},
				edit: {
					name: "srv",
					targetPath: "/tmp/x.json",
					entry: { url: "https://a", description: "Docs", timeout: 30, enabled: false },
				},
			},
			tui,
			() => {},
		);
		expect(p.getFieldValue("description")).toBe("Docs");
		expect(p.getFieldValue("timeout")).toBe("30");
		expect(p.getFieldValue("disabled")).toBe("true");
		expect(stripAnsi(p.render(120).join("\n"))).toContain("Disabled: [x] on");
		p.dispose();
	});

	it("rejects a timeout that is not a positive number", () => {
		for (const timeout of ["0", "-1", "abc", "Infinity"]) {
			const { p, written } = run({ name: "srv", command: "npx", timeout });
			expect(written).toEqual([]);
			expect(p.getStep()).toBe("form");
			expect(p.getError()).toBe("Timeout must be a positive number of seconds.");
			p.dispose();
		}
	});
});
