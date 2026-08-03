import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

const mocks = {
	initializeMcp: mock(),
	updateStatusBar: mock(),
	flushMetadataCache: mock(),
	initializeOAuth: mock().mockResolvedValue(undefined),
	shutdownOAuth: mock().mockResolvedValue(undefined),
	loadMcpConfig: mock((): any => ({ mcpServers: {} })),
	loadMetadataCache: mock((): any => null),
	buildProxyDescription: mock(() => "MCP gateway"),
	createDirectToolExecutor: mock(() => mock()),
	getMissingConfiguredDirectToolServers: mock((): string[] => []),
	resolveDirectTools: mock((): any[] => []),
	showStatus: mock(),
	showTools: mock(),
	reconnectServers: mock(),
	logoutServer: mock(),
	openMcpPanel: mock(),
	openMcpSetup: mock(),
	executeAuthComplete: mock(),
	executeAuthStart: mock(),
	executeCall: mock(),
	executeConnect: mock(),
	executeDescribe: mock(),
	executeList: mock(),
	executeSearch: mock(),
	executeStatus: mock(),
	executeUiMessages: mock(),
	getConfigPathFromArgv: mock(() => undefined),
	normalizeDirectToolInputSchema: mock((schema: unknown) =>
		schema && typeof schema === "object" && !Array.isArray(schema)
			? Object.fromEntries(
					Object.entries(schema).filter(
						([key]) => key !== "$schema" && key !== "additionalProperties",
					),
				)
			: { type: "object", properties: {} },
	),
	truncateAtWord: mock((text: string) => text),
};

mock.module("../src/init.ts", () => ({
	initializeMcp: mocks.initializeMcp,
	updateStatusBar: mocks.updateStatusBar,
	flushMetadataCache: mocks.flushMetadataCache,
}));

mock.module("../src/mcp-auth-flow.ts", () => ({
	initializeOAuth: mocks.initializeOAuth,
	shutdownOAuth: mocks.shutdownOAuth,
}));

mock.module("../src/config.ts", () => ({
	loadMcpConfig: mocks.loadMcpConfig,
}));

mock.module("../src/metadata-cache.ts", () => ({
	loadMetadataCache: mocks.loadMetadataCache,
}));

mock.module("../src/direct-tools.ts", () => ({
	buildProxyDescription: mocks.buildProxyDescription,
	createDirectToolExecutor: mocks.createDirectToolExecutor,
	getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
	resolveDirectTools: mocks.resolveDirectTools,
}));

mock.module("../src/commands.ts", () => ({
	showStatus: mocks.showStatus,
	showTools: mocks.showTools,
	reconnectServers: mocks.reconnectServers,
	logoutServer: mocks.logoutServer,
	openMcpPanel: mocks.openMcpPanel,
	openMcpSetup: mocks.openMcpSetup,
}));

mock.module("../src/proxy-modes.ts", () => ({
	executeAuthComplete: mocks.executeAuthComplete,
	executeAuthStart: mocks.executeAuthStart,
	executeCall: mocks.executeCall,
	executeConnect: mocks.executeConnect,
	executeDescribe: mocks.executeDescribe,
	executeList: mocks.executeList,
	executeSearch: mocks.executeSearch,
	executeStatus: mocks.executeStatus,
	executeUiMessages: mocks.executeUiMessages,
}));

mock.module("../src/utils.ts", () => ({
	getConfigPathFromArgv: mocks.getConfigPathFromArgv,
	normalizeDirectToolInputSchema: mocks.normalizeDirectToolInputSchema,
	truncateAtWord: mocks.truncateAtWord,
}));

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function createState() {
	return {
		manager: { getAllConnections: () => new Map() },
		lifecycle: { gracefulShutdown: mock().mockResolvedValue(undefined) },
		toolMetadata: new Map(),
		config: { mcpServers: {} },
		failureTracker: new Map(),
		uiResourceHandler: {},
		consentManager: {},
		uiServer: null,
		completedUiSessions: [],
		openBrowser: mock(),
	} as any;
}

function createPi() {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	return {
		handlers,
		api: {
			registerTool: mock(),
			registerFlag: mock(),
			registerCommand: mock(),
			on: mock((event: string, handler: (...args: any[]) => unknown) => {
				handlers.set(event, handler);
			}),
			getAllTools: mock(() => []),
		} as any,
	};
}

describe("mcpAdapter session lifecycle", () => {
	const originalDirectTools = process.env.MCP_DIRECT_TOOLS;

	beforeEach(() => {
		delete process.env.MCP_DIRECT_TOOLS;
		for (const value of Object.values(mocks)) {
			if (typeof value === "function" && "mockReset" in value) {
				value.mockReset();
			}
		}

		mocks.initializeOAuth.mockResolvedValue(undefined);
		mocks.shutdownOAuth.mockResolvedValue(undefined);
		mocks.loadMcpConfig.mockReturnValue({ mcpServers: {} });
		mocks.loadMetadataCache.mockReturnValue(null);
		mocks.buildProxyDescription.mockReturnValue("MCP gateway");
		mocks.createDirectToolExecutor.mockReturnValue(mock());
		mocks.getMissingConfiguredDirectToolServers.mockReturnValue([]);
		mocks.resolveDirectTools.mockReturnValue([]);
		mocks.getConfigPathFromArgv.mockReturnValue(undefined);
		mocks.normalizeDirectToolInputSchema.mockImplementation((schema: unknown) =>
			schema && typeof schema === "object" && !Array.isArray(schema)
				? Object.fromEntries(
						Object.entries(schema).filter(
							([key]) => key !== "$schema" && key !== "additionalProperties",
						),
					)
				: { type: "object", properties: {} },
		);
		mocks.truncateAtWord.mockImplementation((text: string) => text);
	});

	afterEach(() => {
		if (originalDirectTools === undefined) {
			delete process.env.MCP_DIRECT_TOOLS;
		} else {
			process.env.MCP_DIRECT_TOOLS = originalDirectTools;
		}
	});

	it("keeps the proxy tool when direct tools are still missing from cache", async () => {
		mocks.loadMcpConfig.mockReturnValue({
			mcpServers: {
				demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
			},
			settings: { disableProxyTool: true },
		});
		mocks.resolveDirectTools.mockReturnValue([
			{
				serverName: "demo",
				originalName: "search",
				prefixedName: "demo_search",
				description: "Search demo",
			},
		]);
		mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["demo"]);

		const { default: mcpAdapter } = await import("../src/index.ts");
		const { api } = createPi();
		mcpAdapter(api);

		expect(api.registerTool).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "demo_search",
				renderResult: expect.any(Function),
			}),
		);
		expect(api.registerTool).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "mcp",
				renderResult: expect.any(Function),
			}),
		);
	});

	it("normalizes direct MCP tool schemas before registration", async () => {
		const schema = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				query: { type: "string" },
				nested: {
					type: "object",
					additionalProperties: false,
				},
			},
			required: ["query"],
			additionalProperties: false,
		};
		mocks.resolveDirectTools.mockReturnValue([
			{
				serverName: "demo",
				originalName: "search",
				prefixedName: "demo_search",
				description: "Search demo",
				inputSchema: schema,
			},
		]);

		const { default: mcpAdapter } = await import("../src/index.ts");
		const { api } = createPi();
		mcpAdapter(api);

		expect(mocks.normalizeDirectToolInputSchema).toHaveBeenCalledWith(schema);
		const directTool = api.registerTool.mock.calls.find(
			(call: any[]) => call[0].name === "demo_search",
		)?.[0];
		expect(directTool.parameters).toMatchObject({
			type: "object",
			properties: {
				query: { type: "string" },
				nested: {
					type: "object",
					additionalProperties: false,
				},
			},
			required: ["query"],
		});
		expect(directTool.parameters).not.toHaveProperty("$schema");
		expect(directTool.parameters).not.toHaveProperty("additionalProperties");
	});

	it("skips the proxy tool once direct tools are fully available", async () => {
		mocks.loadMcpConfig.mockReturnValue({
			mcpServers: {
				demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
			},
			settings: { disableProxyTool: true },
		});
		mocks.resolveDirectTools.mockReturnValue([
			{
				serverName: "demo",
				originalName: "search",
				prefixedName: "demo_search",
				description: "Search demo",
			},
		]);

		const { default: mcpAdapter } = await import("../src/index.ts");
		const { api } = createPi();
		mcpAdapter(api);

		expect(api.registerTool).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "demo_search",
				renderResult: expect.any(Function),
			}),
		);
		expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
	});

	it("routes manual auth actions through the proxy tool", async () => {
		const state = createState();
		mocks.initializeMcp.mockResolvedValue(state);
		mocks.executeAuthStart.mockResolvedValue({ content: [{ type: "text", text: "auth url" }] });
		mocks.executeAuthComplete.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

		const { default: mcpAdapter } = await import("../src/index.ts");
		const { api, handlers } = createPi();
		mcpAdapter(api);

		const sessionStart = handlers.get("session_start");
		await sessionStart?.({}, {});
		await Promise.resolve();
		await Promise.resolve();

		const proxyTool = api.registerTool.mock.calls.find(
			(call: any[]) => call[0].name === "mcp",
		)?.[0];
		expect(proxyTool).toBeDefined();

		await proxyTool.execute("call-1", { action: "auth-start", server: "demo" });
		await proxyTool.execute("call-2", {
			action: "auth-complete",
			server: "demo",
			args: '{"redirectUrl":"http://localhost:19876/callback?code=abc&state=state"}',
		});

		expect(mocks.executeAuthStart).toHaveBeenCalledWith(state, "demo");
		expect(mocks.executeAuthComplete).toHaveBeenCalledWith(
			state,
			"demo",
			"http://localhost:19876/callback?code=abc&state=state",
		);
	});

	it("forwards the proxy tool AbortSignal into executeCall", async () => {
		const state = createState();
		mocks.initializeMcp.mockResolvedValue(state);
		mocks.executeCall.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

		const { default: mcpAdapter } = await import("../src/index.ts");
		const { api, handlers } = createPi();
		mcpAdapter(api);

		const sessionStart = handlers.get("session_start");
		await sessionStart?.({}, {});
		await Promise.resolve();
		await Promise.resolve();

		const proxyTool = api.registerTool.mock.calls.find(
			(call: any[]) => call[0].name === "mcp",
		)?.[0];
		expect(proxyTool).toBeDefined();

		const controller = new AbortController();
		await proxyTool.execute(
			"call-1",
			{ tool: "demo_search", args: '{"q":"hello"}' },
			controller.signal,
		);

		expect(mocks.executeCall).toHaveBeenCalledWith(
			state,
			"demo_search",
			{ q: "hello" },
			undefined,
			expect.any(Function),
			controller.signal,
		);
	});

	it("starts a replacement init immediately and shuts down stale init results", async () => {
		const first = createDeferred<any>();
		const second = createDeferred<any>();
		mocks.initializeMcp.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		const { default: mcpAdapter } = await import("../src/index.ts");
		const { api, handlers } = createPi();
		mcpAdapter(api);

		const sessionStart = handlers.get("session_start");
		expect(sessionStart).toBeTypeOf("function");

		await sessionStart?.({}, {});
		expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
		expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(1);

		await sessionStart?.({}, {});
		expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
		expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(2);

		const activeState = createState();
		second.resolve(activeState);
		await Promise.resolve();
		await Promise.resolve();

		expect(mocks.updateStatusBar).toHaveBeenCalledWith(activeState);
		expect(activeState.lifecycle.gracefulShutdown).not.toHaveBeenCalled();

		const staleState = createState();
		first.resolve(staleState);
		await Promise.resolve();
		await Promise.resolve();

		expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(staleState);
		expect(mocks.flushMetadataCache).toHaveBeenCalledWith(staleState);
		expect(staleState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1);
	});

	it("shuts down OAuth on session_shutdown", async () => {
		const state = createState();
		mocks.initializeMcp.mockResolvedValue(state);

		const { default: mcpAdapter } = await import("../src/index.ts");
		const { api, handlers } = createPi();
		mcpAdapter(api);

		const sessionStart = handlers.get("session_start");
		const sessionShutdown = handlers.get("session_shutdown");

		await sessionStart?.({}, {});
		await Promise.resolve();
		await Promise.resolve();

		mocks.shutdownOAuth.mockClear();

		await sessionShutdown?.();

		expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(1);
	});

	it("routes `/mcp setup` to the onboarding flow", async () => {
		const state = createState();
		mocks.initializeMcp.mockResolvedValue(state);

		const { default: mcpAdapter } = await import("../src/index.ts");
		const { api, handlers } = createPi();
		mcpAdapter(api);

		const sessionStart = handlers.get("session_start");
		await sessionStart?.({}, { hasUI: true, ui: { notify: mock() } });
		await Promise.resolve();
		await Promise.resolve();

		const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
		expect(commandDef).toBeDefined();

		await commandDef.handler("setup", { hasUI: true, ui: { notify: mock() } });

		expect(mocks.openMcpSetup).toHaveBeenCalledWith(
			state,
			api,
			expect.any(Object),
			undefined,
			"setup",
		);
	});

	it("routes `/mcp logout <server>` to credential logout", async () => {
		const state = createState();
		mocks.initializeMcp.mockResolvedValue(state);

		const { default: mcpAdapter } = await import("../src/index.ts");
		const { api, handlers } = createPi();
		mcpAdapter(api);

		const ui = { notify: mock() };
		const sessionStart = handlers.get("session_start");
		await sessionStart?.({}, { hasUI: true, ui });
		await Promise.resolve();
		await Promise.resolve();

		const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
		await commandDef.handler("logout oauth-server", { hasUI: true, ui });

		expect(mocks.logoutServer).toHaveBeenCalledWith("oauth-server", state, expect.any(Object));
	});

	it("shows usage for `/mcp logout` without a server", async () => {
		const state = createState();
		mocks.initializeMcp.mockResolvedValue(state);

		const { default: mcpAdapter } = await import("../src/index.ts");
		const { api, handlers } = createPi();
		mcpAdapter(api);

		const ui = { notify: mock() };
		const sessionStart = handlers.get("session_start");
		await sessionStart?.({}, { hasUI: true, ui });
		await Promise.resolve();
		await Promise.resolve();

		const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
		await commandDef.handler("logout", { hasUI: true, ui });

		expect(mocks.logoutServer).not.toHaveBeenCalled();
		expect(ui.notify).toHaveBeenCalledWith("Usage: /mcp logout <server>", "error");
	});

	it("triggers core reload after setup changes config", async () => {
		const initialState = createState();
		mocks.initializeMcp.mockResolvedValue(initialState);
		mocks.openMcpSetup.mockResolvedValue({ configChanged: true });

		const { default: mcpAdapter } = await import("../src/index.ts");
		const { api, handlers } = createPi();
		mcpAdapter(api);

		const ui = { notify: mock() };
		const reload = mock().mockResolvedValue(undefined);
		const sessionStart = handlers.get("session_start");
		await sessionStart?.({}, { hasUI: true, ui });
		await Promise.resolve();
		await Promise.resolve();

		const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
		await commandDef.handler("setup", { hasUI: true, ui, reload });

		expect(reload).toHaveBeenCalledTimes(1);
		expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
		expect(mocks.flushMetadataCache).not.toHaveBeenCalledWith(initialState);
	});

	it("registers /mcp as the only interactive MCP management command", async () => {
		const { default: mcpAdapter } = await import("../src/index.ts");
		const { api } = createPi();
		mcpAdapter(api);

		const commandNames = api.registerCommand.mock.calls.map((call: any[]) => call[0]);
		expect(commandNames).toContain("mcp");
		expect(commandNames).not.toContain("mcp-auth");
	});

	it("logs initialization errors when updateStatusBar throws", async () => {
		const state = createState();
		mocks.initializeMcp.mockResolvedValue(state);
		mocks.updateStatusBar.mockImplementation(() => {
			throw new Error("status boom");
		});

		const consoleError = spyOn(console, "error").mockImplementation(() => {});

		try {
			const { default: mcpAdapter } = await import("../src/index.ts");
			const { api, handlers } = createPi();
			mcpAdapter(api);

			const sessionStart = handlers.get("session_start");
			expect(sessionStart).toBeTypeOf("function");

			await sessionStart?.({}, {});
			await Promise.resolve();
			await Promise.resolve();
			await new Promise((resolve) => setImmediate(resolve));

			expect(consoleError).toHaveBeenCalledWith("MCP initialization failed:", expect.any(Error));
		} finally {
			consoleError.mockRestore();
		}
	});

	it("registers a tool_result handler that re-flags returned MCP tool failures (and leaves other results alone)", async () => {
		const { default: mcpAdapter } = await import("../src/index.ts");
		const { api, handlers } = createPi();
		mcpAdapter(api);

		const toolResult = handlers.get("tool_result");
		expect(toolResult).toBeDefined();

		// server returned an error result (direct path) -> tagged tool_error
		expect(toolResult?.({ details: { error: "tool_error", server: "demo" } })).toEqual({
			isError: true,
		});
		// the call itself threw and was caught (proxy path) -> tagged call_failed
		expect(
			toolResult?.({ details: { mode: "call", error: "call_failed", message: "boom" } }),
		).toEqual({ isError: true });
		// a precondition code is not a tool-execution failure -> left untouched
		expect(toolResult?.({ details: { error: "auth_required", server: "demo" } })).toBeUndefined();
	});
});
