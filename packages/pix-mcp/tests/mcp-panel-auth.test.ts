import { describe, expect, it, mock } from "bun:test";
import { createMcpPanel } from "../src/mcp-panel.ts";
import { computeServerHash, type MetadataCache } from "../src/metadata-cache.ts";
import type { McpConfig, McpPanelCallbacks } from "../src/types.ts";

function stripAnsi(input: string): string {
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function createCache(config: McpConfig): MetadataCache {
	return {
		version: 1,
		servers: {
			github: {
				configHash: computeServerHash(config.mcpServers.github),
				cachedAt: Date.now(),
				tools: [{ name: "search", description: "Search" }],
				resources: [],
			},
		},
	};
}

function createCallbacks(status: "connected" | "idle" | "failed" | "needs-auth" = "needs-auth") {
	let currentStatus = status;
	const callbacks: McpPanelCallbacks = {
		reconnect: async () => true,
		canAuthenticate: (serverName) => serverName === "github",
		authenticate: mock(async () => {
			currentStatus = "connected";
			return { ok: true, message: 'OAuth authenticated and connected for "github".' };
		}),
		getConnectionStatus: () => currentStatus,
		refreshCacheAfterReconnect: () => null,
	};
	return callbacks;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("mcp-panel auth actions", () => {
	it("authenticates a needs-auth server when pressing enter", async () => {
		const config: McpConfig = {
			mcpServers: {
				github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
			},
		};
		const callbacks = createCallbacks("needs-auth");
		const tui = { requestRender: mock(() => {}) };
		const panel = createMcpPanel(config, createCache(config), new Map(), callbacks, tui, () => {});

		panel.handleInput("\r");
		await Promise.resolve();

		expect(callbacks.authenticate).toHaveBeenCalledWith("github");
		const output = stripAnsi(panel.render(100).join("\n"));
		expect(output).toContain("OAuth authenticated and connected for github");
		panel.dispose();
	});

	it("renders unauthenticated servers dimmed with a needs-auth label", () => {
		const config: McpConfig = {
			mcpServers: {
				github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
			},
		};
		const theme = {
			fg: (color: string, text: string) => `<fg:${color}>${text}</fg>`,
			bg: (_color: string, text: string) => text,
		};
		const panel = createMcpPanel(
			config,
			createCache(config),
			new Map(),
			createCallbacks("needs-auth"),
			{ requestRender: () => {} },
			() => {},
			{ theme },
		);

		const output = panel.render(120).join("\n");
		expect(output).toContain("<fg:dim>github</fg>");
		expect(output).toContain("<fg:dim>needs auth</fg>");
		panel.dispose();
	});

	it("authenticates OAuth-capable idle servers with ctrl+a", async () => {
		const config: McpConfig = {
			mcpServers: {
				github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
			},
		};
		const callbacks = createCallbacks("idle");
		const panel = createMcpPanel(
			config,
			createCache(config),
			new Map(),
			callbacks,
			{ requestRender: () => {} },
			() => {},
		);

		panel.handleInput("\x01");
		await Promise.resolve();

		expect(callbacks.authenticate).toHaveBeenCalledWith("github");
		panel.dispose();
	});

	it("shows concrete auth failure messages in the panel", async () => {
		const config: McpConfig = {
			mcpServers: {
				github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
			},
		};
		const callbacks = createCallbacks("needs-auth");
		callbacks.authenticate = mock(async () => ({ ok: false, message: "browser launch failed" }));
		const panel = createMcpPanel(
			config,
			createCache(config),
			new Map(),
			callbacks,
			{ requestRender: () => {} },
			() => {},
		);

		panel.handleInput("\r");
		await Promise.resolve();

		const output = stripAnsi(panel.render(100).join("\n"));
		expect(output).toContain("OAuth failed for github: browser launch failed");
		panel.dispose();
	});

	it("sanitizes OSC sequences in auth notice server names and messages", async () => {
		const serverName = "git\x9d8;;https://example.invalid/server\x1b\\hub\x9d8;;\x1b\\";
		const config: McpConfig = {
			mcpServers: {
				[serverName]: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
			},
		};
		const callbacks = createCallbacks("needs-auth");
		callbacks.canAuthenticate = () => true;
		callbacks.authenticate = mock(async () => ({
			ok: false,
			message: "browser \x9d8;;https://example.invalid/error\x1b\\launch\x9d8;;\x1b\\ failed",
		}));
		callbacks.getConnectionStatus = () => "needs-auth";
		const panel = createMcpPanel(
			config,
			null,
			new Map(),
			callbacks,
			{ requestRender: () => {} },
			() => {},
		);

		panel.handleInput("\r");
		await Promise.resolve();

		const output = stripAnsi(panel.render(100).join("\n"));
		expect(output).toContain("OAuth failed for github: browser launch failed");
		expect(output).not.toContain("\x1b]");
		expect(output).not.toContain("\x9d");
		expect(output).not.toContain("https://example.invalid/server");
		expect(output).not.toContain("https://example.invalid/error");
		panel.dispose();
	});

	it("does not start duplicate auth while auth is already in flight", async () => {
		const config: McpConfig = {
			mcpServers: {
				github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
			},
		};
		const callbacks = createCallbacks("needs-auth");
		const auth = deferred<{ ok: boolean }>();
		callbacks.authenticate = mock(() => auth.promise);
		const panel = createMcpPanel(
			config,
			createCache(config),
			new Map(),
			callbacks,
			{ requestRender: () => {} },
			() => {},
		);

		panel.handleInput("\r");
		panel.handleInput("\r");
		panel.handleInput("\x01");

		expect(callbacks.authenticate).toHaveBeenCalledTimes(1);
		auth.resolve({ ok: true });
		await Promise.resolve();
		panel.dispose();
	});
});
