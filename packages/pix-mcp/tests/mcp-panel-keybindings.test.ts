import { describe, expect, it, mock } from "bun:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { McpDiscoverySummary } from "../src/config.ts";
import { createMcpPanel } from "../src/mcp-panel.ts";
import { createMcpSetupPanel, type SetupPanelCallbacks } from "../src/mcp-setup-panel.ts";
import { createPanelKeys } from "../src/panel-keys.ts";
import type { McpConfig, McpPanelCallbacks } from "../src/types.ts";

const CTRL_P = "\x10";
const CTRL_N = "\x0e";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";

function createEmacsKeybindings(): KeybindingsManager {
	return new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.up": ["up", "ctrl+p"],
		"tui.select.down": ["down", "ctrl+n"],
	});
}

function createTwoServerConfig(): McpConfig {
	return {
		mcpServers: {
			alpha: { url: "https://alpha.example.com/mcp", auth: "oauth" },
			beta: { url: "https://beta.example.com/mcp", auth: "oauth" },
		},
	};
}

function createAuthCallbacks(): McpPanelCallbacks {
	return {
		reconnect: async () => true,
		canAuthenticate: () => true,
		authenticate: mock(async () => ({ ok: true })),
		getConnectionStatus: () => "needs-auth",
		refreshCacheAfterReconnect: () => null,
	};
}

function createEmptyDiscovery(): McpDiscoverySummary {
	return {
		sources: [],
		imports: [],
		hasAnyConfig: false,
		hasAnyDetectedPaths: false,
		hasSharedServers: false,
		hasPiOwnedServers: false,
		totalServerCount: 0,
		fingerprint: "test",
		repoPrompt: { configured: false },
	};
}

function createSetupCallbacks(): SetupPanelCallbacks {
	const preview = {
		path: "/tmp/x",
		existed: false,
		changed: true,
		beforeText: "",
		afterText: "",
		diffText: "",
	};
	return {
		previewImports: () => preview,
		previewStarterProject: () => preview,
		previewRepoPrompt: () => null,
		adoptImports: async () => ({ added: [], path: "/tmp/x" }),
		scaffoldProjectConfig: mock(async () => ({ path: "/tmp/x" })),
		addRepoPrompt: async () => ({ path: "/tmp/x", serverName: "repoprompt" }),
		openPath: async () => {},
		markSetupCompleted: () => {},
	};
}

describe("panel-keys", () => {
	it("honors user keybindings when a manager is provided", () => {
		const keys = createPanelKeys(createEmacsKeybindings());
		expect(keys.selectUp(CTRL_P)).toBe(true);
		expect(keys.selectUp(UP)).toBe(true);
		expect(keys.selectDown(CTRL_N)).toBe(true);
		expect(keys.selectDown(DOWN)).toBe(true);
		expect(keys.selectConfirm(ENTER)).toBe(true);
	});

	it("falls back to hardcoded defaults without a manager", () => {
		const keys = createPanelKeys();
		expect(keys.selectUp(UP)).toBe(true);
		expect(keys.selectUp(CTRL_P)).toBe(false);
		expect(keys.selectDown(DOWN)).toBe(true);
		expect(keys.selectDown(CTRL_N)).toBe(false);
		expect(keys.selectConfirm(ENTER)).toBe(true);
	});

	it("respects rebinding that removes a default key", () => {
		const manager = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.up": "ctrl+p",
		});
		const keys = createPanelKeys(manager);
		expect(keys.selectUp(CTRL_P)).toBe(true);
		expect(keys.selectUp(UP)).toBe(false);
	});
});

describe("mcp-panel custom keybindings", () => {
	it("navigates with ctrl+n/ctrl+p when bound to tui.select.down/up", async () => {
		const callbacks = createAuthCallbacks();
		const panel = createMcpPanel(
			createTwoServerConfig(),
			null,
			new Map(),
			callbacks,
			{ requestRender: () => {} },
			() => {},
			{ keybindings: createEmacsKeybindings() },
		);

		// Start on "+ Add server" row; one ctrl+n → alpha, two → beta.
		panel.handleInput(CTRL_N); // → alpha
		panel.handleInput(CTRL_N); // → beta
		panel.handleInput(ENTER);
		await Promise.resolve();
		expect(callbacks.authenticate).toHaveBeenLastCalledWith("beta");

		panel.handleInput(CTRL_P); // → alpha
		panel.handleInput(ENTER);
		await Promise.resolve();
		expect(callbacks.authenticate).toHaveBeenLastCalledWith("alpha");
		panel.dispose();
	});

	it("keeps arrow keys working alongside custom bindings", async () => {
		const callbacks = createAuthCallbacks();
		const panel = createMcpPanel(
			createTwoServerConfig(),
			null,
			new Map(),
			callbacks,
			{ requestRender: () => {} },
			() => {},
			{ keybindings: createEmacsKeybindings() },
		);

		panel.handleInput(DOWN); // → alpha
		panel.handleInput(DOWN); // → beta
		panel.handleInput(ENTER);
		await Promise.resolve();
		expect(callbacks.authenticate).toHaveBeenLastCalledWith("beta");
		panel.dispose();
	});

	it("treats ctrl+p/ctrl+n as unbound without a keybindings manager", async () => {
		const callbacks = createAuthCallbacks();
		const panel = createMcpPanel(
			createTwoServerConfig(),
			null,
			new Map(),
			callbacks,
			{ requestRender: () => {} },
			() => {},
			{},
		);

		// Fallback: ctrl+n not bound → stays on Add row (requests add, not auth).
		panel.handleInput(CTRL_N);
		panel.handleInput(DOWN); // → alpha
		panel.handleInput(ENTER);
		await Promise.resolve();
		expect(callbacks.authenticate).toHaveBeenLastCalledWith("alpha");
		panel.dispose();
	});
});

describe("mcp-setup-panel custom keybindings", () => {
	it("uses the shared Pix popup frame and host theme", () => {
		const theme = {
			fg: (color: string, text: string) => `<fg:${color}>${text}</fg>`,
			bg: (color: string, text: string) => `<bg:${color}>${text}</bg>`,
			bold: (text: string) => `<b>${text}</b>`,
		};
		const panel = createMcpSetupPanel(
			createEmptyDiscovery(),
			createSetupCallbacks(),
			{
				mode: "setup",
				onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false },
			},
			{ requestRender: () => {} },
			() => {},
			theme,
		);

		const lines = panel.render(120);

		expect(lines[0]).toContain("<bg:customMessageBg>");
		expect(lines[0]).toContain("<fg:accent>╭");
		expect(lines.at(-1)).toContain("╰");
		expect(lines.join("\n")).toContain("<fg:accent><b>");
		expect(lines.join("\n")).toContain("MCP setup</b></fg>");
		expect(lines.join("\n")).toContain("discover · import · configure external MCP servers");
		expect(lines.join("\n")).toContain("<fg:text>↑↓</fg><fg:dim> navigate</fg>");
		expect(lines.join("\n")).toContain("<fg:text>enter</fg>");
		expect(lines.join("\n")).toContain("<fg:text>esc</fg><fg:dim> back</fg>");
		panel.dispose();
	});

	it("navigates actions with ctrl+n and confirms with enter", async () => {
		const callbacks = createSetupCallbacks();
		const panel = createMcpSetupPanel(
			createEmptyDiscovery(),
			callbacks,
			{
				mode: "setup",
				onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false },
				keybindings: createEmacsKeybindings(),
			},
			{ requestRender: () => {} },
			() => {},
		);

		// Actions for this discovery: view-example, scaffold-project, show-precedence, close.
		panel.handleInput(CTRL_N);
		panel.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();
		expect(callbacks.scaffoldProjectConfig).toHaveBeenCalledTimes(1);
		panel.dispose();
	});
});
