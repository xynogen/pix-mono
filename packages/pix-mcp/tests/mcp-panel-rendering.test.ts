import { describe, expect, it, mock } from "bun:test";
import { createMcpPanel } from "../src/mcp-panel.ts";
import { computeServerHash, type MetadataCache } from "../src/metadata-cache.ts";
import type { McpConfig, McpPanelCallbacks, McpPanelResult } from "../src/types.ts";

function stripAnsi(input: string): string {
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function createCallbacks(): McpPanelCallbacks {
	return {
		reconnect: async () => true,
		canAuthenticate: () => false,
		authenticate: async () => ({ ok: false }),
		getConnectionStatus: () => "idle",
		refreshCacheAfterReconnect: () => null,
	};
}

function createConfig(): McpConfig {
	return {
		mcpServers: {
			atlassian: { command: "npx", args: ["-y", "atlassian-mcp"] },
		},
	};
}

function createCache(config: McpConfig): MetadataCache {
	return {
		version: 1,
		servers: {
			atlassian: {
				configHash: computeServerHash(config.mcpServers.atlassian),
				cachedAt: Date.now(),
				tools: [
					{
						name: "search\u0007issues",
						description:
							"Search\r\n\x1b[31m\x9d8;;https://example.invalid/issues\x1b\\issues\x9d8;;\x1b\\\x1b[0m\tby query\u0000now",
					},
					{ name: "list_projects", description: "List projects" },
				],
				resources: [],
			},
		},
	};
}

describe("mcp-panel rendering", () => {
	it("uses the shared Pix popup frame, theme background, and accent", () => {
		const config = createConfig();
		const theme = {
			fg: (color: string, text: string) => `<fg:${color}>${text}</fg>`,
			bg: (color: string, text: string) => `<bg:${color}>${text}</bg>`,
			bold: (text: string) => `<b>${text}</b>`,
		};
		const panel = createMcpPanel(
			config,
			createCache(config),
			new Map(),
			createCallbacks(),
			{ requestRender: () => {} },
			() => {},
			{ theme },
		);

		const lines = panel.render(82);

		expect(lines[0]).toContain("<bg:customMessageBg>");
		expect(lines[0]).toContain("<fg:accent>╭");
		expect(lines.at(-1)).toContain("╰");
		expect(lines.join("\n")).toContain("<fg:accent><b>");
		expect(lines.join("\n")).toContain("MCP servers</b></fg>");
		expect(lines.join("\n")).toContain("servers · direct tools · estimated prompt cost");
		expect(lines.join("\n")).toContain("<fg:dim>Search:</fg>");
		panel.dispose();
	});

	it("renders MCP metadata as single-line display text", () => {
		const config = createConfig();
		const panel = createMcpPanel(
			config,
			createCache(config),
			new Map(),
			createCallbacks(),
			{ requestRender: () => {} },
			() => {},
		);

		panel.handleInput("\u001b[B"); // past + Add server row to first server
		panel.handleInput("\r");

		const lines = panel.render(120);
		const output = stripAnsi(lines.join("\n"));

		expect(output).toContain("search issues");
		expect(output).toContain("Search issues by query now");
		expect(lines.some((line) => /[\r\n\u0000-\u001f\u007f-\u009f]/.test(stripAnsi(line)))).toBe(
			false,
		);
		expect(output).not.toContain("[31m");
		expect(output).not.toContain("\x1b]");
		expect(output).not.toContain("\x9d");
		expect(output).not.toContain("https://example.invalid/issues");
		panel.dispose();
	});

	it("sanitizes OSC sequences in notice lines before styling", () => {
		const config = createConfig();
		const panel = createMcpPanel(
			config,
			createCache(config),
			new Map(),
			createCallbacks(),
			{ requestRender: () => {} },
			() => {},
			{ noticeLines: ["Open \x1b]8;;https://example.invalid/notice\x07docs\x1b]8;;\x07 now"] },
		);

		const output = stripAnsi(panel.render(120).join("\n"));

		expect(output).toContain("Open docs now");
		expect(output).not.toContain("\x1b]");
		expect(output).not.toContain("https://example.invalid/notice");
		panel.dispose();
	});

	it("keeps dirty changes and closes when Keep & Close is confirmed", () => {
		const config = createConfig();
		const done = mock<(result: McpPanelResult) => void>();
		const panel = createMcpPanel(
			config,
			createCache(config),
			new Map(),
			createCallbacks(),
			{ requestRender: () => {} },
			done,
		);

		panel.handleInput("\u001b[B"); // past + Add server to first server
		panel.handleInput("\r");
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		panel.handleInput("\x1b");

		expect(stripAnsi(panel.render(120).join("\n"))).toContain("Keep & Close");

		panel.handleInput("\r");

		expect(done).toHaveBeenCalledTimes(1);
		const result = done.mock.calls[0][0];
		expect(result.cancelled).toBe(false);
		expect(result.changes.get("atlassian")).toEqual(["search\u0007issues"]);
		panel.dispose();
	});
});
