import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { dirname, join } from "node:path";

import { tempDir } from "@xynogen/pix-runtime/paths";

// Bun caches os.homedir() at startup on Linux, so a HOME set by the test
// preload would not reach src/config.ts. Resolve home from the env instead.
const systemHomedir = nodeOs.homedir();
mock.module("node:os", () => ({
	...nodeOs,
	homedir: () => process.env.HOME ?? systemHomedir,
}));

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

const originalHome = process.env.HOME;
const mocks = {
	createMcpPanel: mock((..._args: any[]) => {}),
	createMcpSetupPanel: mock((..._args: any[]) => {}),
};

mock.module("../src/mcp-panel.ts", () => ({
	createMcpPanel: mocks.createMcpPanel,
}));

mock.module("../src/mcp-setup-panel.ts", () => ({
	createMcpSetupPanel: mocks.createMcpSetupPanel,
}));

describe("commands onboarding", () => {
	const originalOAuthDir = process.env.MCP_OAUTH_DIR;
	const originalCwd = process.cwd();
	const sharedConfigPath = join(originalHome ?? "", ".config", "mcp", "mcp.json");
	const onboardingPath = join(originalHome ?? "", ".pi", "agent", "mcp-onboarding.json");

	beforeEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		rmSync(onboardingPath, { force: true });
		mocks.createMcpPanel
			.mockReset()
			.mockImplementation((_config, _cache, _prov, _callbacks, _tui, done, _options) => {
				done({ cancelled: true, changes: new Map() });
				return { dispose() {} };
			});
		mocks.createMcpSetupPanel
			.mockReset()
			.mockImplementation((_discovery, _callbacks, _options, _tui, done) => {
				done();
				return { dispose() {} };
			});
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalOAuthDir === undefined) {
			delete process.env.MCP_OAUTH_DIR;
		} else {
			if (originalOAuthDir === undefined) delete process.env.MCP_OAUTH_DIR;
			else process.env.MCP_OAUTH_DIR = originalOAuthDir;
		}
		process.chdir(originalCwd);
	});

	function createUi() {
		return {
			notify: mock(() => {}),
			setStatus: mock(() => {}),
			custom: mock((renderer: any) =>
				renderer(
					{ requestRender: mock(() => {}) },
					{},
					{},
					mock(() => {}),
				),
			),
		};
	}

	it("opens setup mode when no MCP servers are configured", async () => {
		const ui = createUi();
		const { openMcpPanel } = await import("../src/commands.ts");

		await openMcpPanel(
			{
				config: { mcpServers: {} },
				manager: { getConnection: () => null },
				toolMetadata: new Map(),
				failureTracker: new Map(),
			} as any,
			{ getFlag: () => undefined } as any,
			{ hasUI: true, ui } as any,
		);

		expect(mocks.createMcpSetupPanel).toHaveBeenCalled();
		expect(mocks.createMcpPanel).not.toHaveBeenCalled();
	});

	it("shows a one-time shared-config notice in the MCP panel", async () => {
		const project = mkdtempSync(join(tempDir(), "pi-mcp-commands-project-"));
		process.chdir(project);

		rmSync(sharedConfigPath, { force: true });
		writeJson(sharedConfigPath, {
			mcpServers: {
				sharedServer: { command: "shared" },
			},
		});

		const ui = createUi();
		const { loadMcpConfig } = await import("../src/config.ts");
		const { openMcpPanel } = await import("../src/commands.ts");
		const { loadOnboardingState } = await import("../src/onboarding-state.ts");

		await openMcpPanel(
			{
				config: loadMcpConfig(),
				manager: { getConnection: () => null },
				toolMetadata: new Map(),
				failureTracker: new Map(),
			} as any,
			{ getFlag: () => undefined } as any,
			{ hasUI: true, ui } as any,
		);

		expect(mocks.createMcpPanel).toHaveBeenCalled();
		const options = mocks.createMcpPanel.mock.calls[0]?.[6];
		expect(options).toEqual(
			expect.objectContaining({
				noticeLines: expect.arrayContaining([expect.stringContaining("Using standard MCP config")]),
			}),
		);
		expect(loadOnboardingState().sharedConfigHintShown).toBe(true);
		rmSync(sharedConfigPath, { force: true });
	});

	it("removeAuth clears OAuth credentials and cancels pending auth", async () => {
		process.env.MCP_OAUTH_DIR = mkdtempSync(join(tempDir(), "pi-mcp-commands-logout-"));
		const { getAuthEntry, updateOAuthState, updateTokens } = await import("../src/mcp-auth.ts");
		const { waitForCallback } = await import("../src/mcp-callback-server.ts");
		const { removeAuth } = await import("../src/mcp-auth-flow.ts");

		updateTokens(
			"oauth-server",
			{ accessToken: "token", refreshToken: "refresh" },
			"https://example.com/mcp",
		);
		updateOAuthState("oauth-server", "pending-state", "https://example.com/mcp");
		const pendingCallbackResult = waitForCallback("pending-state").then(
			() => null,
			(error: Error) => error,
		);

		await removeAuth("oauth-server");

		expect((await pendingCallbackResult)?.message).toBe("Authorization cancelled");
		expect(getAuthEntry("oauth-server")).toBeUndefined();
	});

	it("marks explicit OAuth servers as needs-auth when only stale URL tokens exist", async () => {
		process.env.MCP_OAUTH_DIR = mkdtempSync(join(tempDir(), "pi-mcp-commands-oauth-"));
		const ui = createUi();
		const { updateTokens } = await import("../src/mcp-auth.ts");
		const { openMcpPanel } = await import("../src/commands.ts");

		updateTokens("legacy", { accessToken: "legacy-token" });
		updateTokens("stale", { accessToken: "stale-token" }, "https://old.example.com/mcp");

		await openMcpPanel(
			{
				config: {
					mcpServers: {
						legacy: { url: "https://new.example.com/mcp", auth: "oauth" },
						stale: { url: "https://new.example.com/mcp", auth: "oauth" },
					},
				},
				manager: { getConnection: () => null },
				toolMetadata: new Map(),
				failureTracker: new Map(),
			} as any,
			{ getFlag: () => undefined } as any,
			{ hasUI: true, ui } as any,
		);

		const callbacks = mocks.createMcpPanel.mock.calls[0]?.[3];
		expect(callbacks.getConnectionStatus("legacy")).toBe("needs-auth");
		expect(callbacks.getConnectionStatus("stale")).toBe("needs-auth");
	});
});
