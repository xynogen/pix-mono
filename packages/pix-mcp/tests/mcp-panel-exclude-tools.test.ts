import { describe, expect, it } from "bun:test";
import { createMcpPanel } from "../src/mcp-panel.ts";
import { computeServerHash, type MetadataCache } from "../src/metadata-cache.ts";
import type { McpConfig } from "../src/types.ts";

function stripAnsi(input: string): string {
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("mcp-panel excludeTools", () => {
	it("hides excluded tools from the panel view", () => {
		const config: McpConfig = {
			settings: { toolPrefix: "server" },
			mcpServers: {
				figma: {
					command: "npx",
					args: ["-y", "figma"],
					directTools: true,
					excludeTools: ["figma_get_screenshot", "get_figjam"],
				},
			},
		};

		const cache: MetadataCache = {
			version: 1,
			servers: {
				figma: {
					configHash: computeServerHash(config.mcpServers.figma!),
					cachedAt: Date.now(),
					tools: [
						{ name: "get_screenshot", description: "Screenshot" },
						{ name: "get_nodes", description: "Nodes" },
					],
					resources: [{ name: "figjam", uri: "ui://figjam", description: "FigJam" }],
				},
			},
		};

		const panel = createMcpPanel(
			config,
			cache,
			new Map(),
			{
				reconnect: async () => true,
				disconnect: async () => {},
				canAuthenticate: () => false,
				authenticate: async () => ({ ok: false }),
				getConnectionStatus: () => "idle",
				refreshCacheAfterReconnect: () => null,
			},
			{ requestRender: () => {} },
			() => {},
		);

		panel.handleInput("g");
		panel.handleInput("e");
		panel.handleInput("t");
		panel.handleInput("_");

		const output = stripAnsi(panel.render(120).join("\n"));

		expect(output).toContain("get_nodes");
		expect(output).not.toContain("get_screenshot");
		expect(output).not.toContain("get_figjam");

		panel.dispose();
	});
});
