import { beforeEach, describe, expect, it, mock } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

const mocks = {
	loadMcpConfig: mock(() => ({ mcpServers: {}, settings: {} })),
	managers: [] as any[],
};

mock.module("../src/config.ts", () => ({
	loadMcpConfig: mocks.loadMcpConfig,
}));

mock.module("../src/server-manager.ts", () => ({
	McpServerManager: mock(() => {
		const manager = {
			setDefaultRequestTimeoutMs: mock(() => {}),
			setSamplingConfig: mock(() => {}),
			setProviderTokenResolver: mock(() => {}),
			setElicitationConfig: mock(() => {}),
			getConnection: mock(() => {}),
			connect: mock(() => {}),
		};
		mocks.managers.push(manager);
		return manager;
	}),
}));

function context(
	overrides: { hasUI?: boolean; mode?: ExtensionContext["mode"] } = {},
): ExtensionContext {
	return {
		cwd: "/tmp/project",
		hasUI: true,
		mode: "tui",
		ui: {
			select: mock(() => {}),
			input: mock(() => {}),
			notify: mock(() => {}),
		} as unknown as ExtensionUIContext,
		modelRegistry: {},
		model: undefined,
		signal: undefined,
		...overrides,
	} as unknown as ExtensionContext;
}

function extensionApi(): ExtensionAPI {
	return { getFlag: mock(() => {}) } as unknown as ExtensionAPI;
}

describe("initializeMcp elicitation config", () => {
	beforeEach(() => {
		mocks.managers.length = 0;
		mocks.loadMcpConfig.mockReturnValue({ mcpServers: {}, settings: {} });
	});

	it("enables form and URL elicitation in TUI mode", async () => {
		const { initializeMcp } = await import("../src/init.ts");
		const { McpServerManager } = await import("../src/server-manager.ts");
		const ctx = context();

		await initializeMcp(extensionApi(), ctx);

		expect(McpServerManager).toHaveBeenCalledWith(ctx.cwd);
		expect(mocks.managers[0].setElicitationConfig).toHaveBeenCalledWith({
			ui: ctx.ui,
			allowUrl: true,
		});
	});

	it("keeps RPC elicitation form-only so the backend never opens a browser", async () => {
		const { initializeMcp } = await import("../src/init.ts");
		const ctx = context({ mode: "rpc" });

		await initializeMcp(extensionApi(), ctx);

		expect(mocks.managers[0].setElicitationConfig).toHaveBeenCalledWith({
			ui: ctx.ui,
			allowUrl: false,
		});
	});

	it("wires requestTimeoutMs override, else falls back to the shared I/O timeout", async () => {
		const { initializeMcp } = await import("../src/init.ts");

		mocks.loadMcpConfig.mockReturnValue({
			mcpServers: {},
			settings: { requestTimeoutMs: 1500 },
		});
		await initializeMcp(extensionApi(), context());
		expect(mocks.managers[0].setDefaultRequestTimeoutMs).toHaveBeenCalledWith(1500);

		mocks.loadMcpConfig.mockReturnValue({ mcpServers: {}, settings: {} });
		await initializeMcp(extensionApi(), context());
		const fallback = mocks.managers[1].setDefaultRequestTimeoutMs.mock.calls[0][0];
		expect(typeof fallback).toBe("number");
		expect(fallback).toBeGreaterThan(0);
	});

	it("does not enable elicitation without UI or when disabled", async () => {
		const { initializeMcp } = await import("../src/init.ts");

		await initializeMcp(extensionApi(), context({ hasUI: false }));
		expect(mocks.managers[0].setElicitationConfig).not.toHaveBeenCalled();

		mocks.loadMcpConfig.mockReturnValue({ mcpServers: {}, settings: { elicitation: false } });
		await initializeMcp(extensionApi(), context());
		expect(mocks.managers[1].setElicitationConfig).not.toHaveBeenCalled();
	});
});
