import { beforeEach, describe, expect, it, mock } from "bun:test";

const mocks = {
	authenticate: mock(),
	supportsOAuth: mock(),
	lazyConnect: mock(),
	updateServerMetadata: mock(),
	updateMetadataCache: mock(),
	getFailureAgeSeconds: mock(),
	updateStatusBar: mock(),
	clients: [] as any[],
	transports: [] as any[],
	connectImpl: mock(),
	listToolsImpl: mock(),
	listResourcesImpl: mock(),
	callToolImpl: mock(),
};

mock.module("../src/mcp-auth-flow.ts", () => ({
	authenticate: mocks.authenticate,
	extractOAuthConfig: mock(() => undefined),
	completeAuthFromInput: mock(),
	startAuth: mock(),
	supportsOAuth: mocks.supportsOAuth,
}));

mock.module("../src/init.ts", () => ({
	lazyConnect: mocks.lazyConnect,
	updateServerMetadata: mocks.updateServerMetadata,
	updateMetadataCache: mocks.updateMetadataCache,
	getFailureAgeSeconds: mocks.getFailureAgeSeconds,
	updateStatusBar: mocks.updateStatusBar,
}));

// SDK v2 collapsed Client + HTTP/SSE transports into @modelcontextprotocol/client
// (stdio stays a subpath) and dropped the result-schema arg from callTool, so
// it is now callTool(params, requestOptions). mock.module is process-global —
// spread the real barrel so unrelated exports survive for other source files.
const realClient = await import("@modelcontextprotocol/client");
mock.module("@modelcontextprotocol/client", () => ({
	...realClient,
	Client: mock((info: unknown, options: unknown) => {
		const client = {
			info,
			options,
			setRequestHandler: mock(),
			setNotificationHandler: mock(),
			connect: mock((transport: unknown, requestOptions: unknown) =>
				mocks.connectImpl(transport, requestOptions),
			),
			listTools: mock((params: unknown, requestOptions: unknown) =>
				mocks.listToolsImpl(params, requestOptions),
			),
			listResources: mock((params: unknown, requestOptions: unknown) =>
				mocks.listResourcesImpl(params, requestOptions),
			),
			callTool: mock((params: unknown, requestOptions: unknown) =>
				mocks.callToolImpl(params, requestOptions),
			),
			close: mock(async () => undefined),
		};
		mocks.clients.push(client);
		return client;
	}),
	StreamableHTTPClientTransport: mock(),
	SSEClientTransport: mock(),
}));

mock.module("@modelcontextprotocol/client/stdio", () => ({
	StdioClientTransport: mock((options: unknown) => {
		const transport = { options, close: mock(async () => undefined) };
		mocks.transports.push(transport);
		return transport;
	}),
}));

mock.module("../src/npx-resolver.ts", () => ({
	resolveNpxBinary: mock(async () => null),
}));

describe("proxy auto auth", () => {
	beforeEach(() => {
		mocks.authenticate.mockReset().mockResolvedValue("authenticated");
		mocks.supportsOAuth.mockReset().mockReturnValue(true);
		mocks.lazyConnect.mockReset().mockResolvedValue(false);
		mocks.updateServerMetadata.mockReset();
		mocks.updateMetadataCache.mockReset();
		mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
		mocks.updateStatusBar.mockReset();
		mocks.clients.length = 0;
		mocks.transports.length = 0;
		mocks.connectImpl.mockReset().mockResolvedValue(undefined);
		mocks.listToolsImpl.mockReset().mockResolvedValue({ tools: [] });
		mocks.listResourcesImpl.mockReset().mockResolvedValue({ resources: [] });
		mocks.callToolImpl.mockReset().mockResolvedValue({
			isError: false,
			content: [{ type: "text", text: "ok" }],
		});
	});

	it("auto-authenticates and retries executeConnect once", async () => {
		const { executeConnect } = await import("../src/proxy-modes.ts");

		let current: any;
		const connected = {
			status: "connected",
			tools: [{ name: "search", description: "Search" }],
			resources: [],
		};

		const manager = {
			connect: mock()
				.mockImplementationOnce(async () => {
					current = { status: "needs-auth" };
					return current;
				})
				.mockImplementationOnce(async () => {
					current = connected;
					return current;
				}),
			close: mock(async () => {
				current = undefined;
			}),
			getConnection: mock(() => current),
		};

		const state = {
			config: {
				settings: { autoAuth: true, toolPrefix: "server" },
				mcpServers: {
					demo: { url: "https://api.example.com/mcp", auth: "oauth" },
				},
			},
			manager,
			toolMetadata: new Map(),
			failureTracker: new Map(),
			ui: { setStatus: mock() },
		} as any;

		const result = await executeConnect(state, "demo");

		expect(mocks.authenticate).toHaveBeenCalledWith(
			"demo",
			"https://api.example.com/mcp",
			state.config.mcpServers.demo,
		);
		expect(manager.close).toHaveBeenCalledWith("demo");
		expect(manager.connect).toHaveBeenCalledTimes(2);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
			"demo: 1 tools",
		);
	});

	it("fails fast for non-ui browser auth when autoAuth is enabled", async () => {
		const { executeConnect } = await import("../src/proxy-modes.ts");

		const manager = {
			connect: mock(async () => ({ status: "needs-auth" })),
			close: mock(async () => {}),
			getConnection: mock(() => ({ status: "needs-auth" })),
		};

		const state = {
			config: {
				settings: { autoAuth: true },
				mcpServers: {
					demo: { url: "https://api.example.com/mcp", auth: "oauth" },
				},
			},
			manager,
			toolMetadata: new Map(),
			failureTracker: new Map(),
			ui: undefined,
		} as any;

		const result = await executeConnect(state, "demo");

		expect(mocks.authenticate).not.toHaveBeenCalled();
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
			"auth-start",
		);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("open /mcp");
	});

	it("uses custom authRequiredMessage for non-ui autoAuth failures", async () => {
		const { executeConnect } = await import("../src/proxy-modes.ts");

		const state = {
			config: {
				settings: {
					autoAuth: true,
					authRequiredMessage: `Reconnect \${server} from the host app.`,
				},
				mcpServers: {
					demo: { url: "https://api.example.com/mcp", auth: "oauth" },
				},
			},
			manager: {
				connect: mock(async () => ({ status: "needs-auth" })),
				close: mock(async () => {}),
				getConnection: mock(() => ({ status: "needs-auth" })),
			},
			toolMetadata: new Map(),
			failureTracker: new Map(),
			ui: undefined,
		} as any;

		const result = await executeConnect(state, "demo");

		expect(mocks.authenticate).not.toHaveBeenCalled();
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toBe(
			"Reconnect demo from the host app.",
		);
	});

	it("runs URL elicitations returned by proxy tool calls", async () => {
		const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/client");
		const { executeCall } = await import("../src/proxy-modes.ts");
		const error = new UrlElicitationRequiredError([
			{
				mode: "url",
				message: "Connect your account",
				elicitationId: "connect-1",
				url: "https://example.com/connect",
			},
		]);
		const connection = {
			status: "connected",
			client: { callTool: mock().mockRejectedValue(error) },
		};
		const manager = {
			getConnection: mock(() => connection),
			handleUrlElicitationRequired: mock().mockResolvedValue("accept"),
			touch: mock(),
			incrementInFlight: mock(),
			decrementInFlight: mock(),
		};
		const state = {
			config: { settings: {}, mcpServers: { demo: { command: "demo" } } },
			manager,
			toolMetadata: new Map([
				[
					"demo",
					[
						{
							name: "demo_search",
							originalName: "search",
							description: "Search",
							inputSchema: { type: "object", properties: {} },
						},
					],
				],
			]),
			failureTracker: new Map(),
			completedUiSessions: [],
		} as any;

		const result = await executeCall(state, "demo_search", {}, "demo");

		expect(manager.handleUrlElicitationRequired).toHaveBeenCalledWith("demo", error);
		expect(result.details).toMatchObject({ error: "url_elicitation_required", action: "accept" });
	});

	it("auto-authenticates and retries executeCall once", async () => {
		const { executeCall } = await import("../src/proxy-modes.ts");

		let current: any = { status: "needs-auth" };
		const connected = {
			status: "connected",
			client: {
				callTool: mock(async () => ({
					isError: false,
					content: [{ type: "text", text: "ok" }],
				})),
			},
			tools: [{ name: "search", description: "Search" }],
			resources: [],
		};

		const manager = {
			connect: mock(async () => {
				current = connected;
				return connected;
			}),
			close: mock(async () => {
				current = undefined;
			}),
			getConnection: mock(() => current),
			getRequestOptions: mock(() => ({ timeout: 1234 })),
			touch: mock(),
			incrementInFlight: mock(),
			decrementInFlight: mock(),
		};

		const state = {
			config: {
				settings: { autoAuth: true, toolPrefix: "server" },
				mcpServers: {
					demo: { url: "https://api.example.com/mcp", auth: "oauth" },
				},
			},
			manager,
			toolMetadata: new Map([
				[
					"demo",
					[
						{
							name: "demo_search",
							originalName: "search",
							description: "Search",
							inputSchema: { type: "object", properties: {} },
						},
					],
				],
			]),
			failureTracker: new Map(),
			ui: { setStatus: mock() },
			completedUiSessions: [],
		} as any;

		const controller = new AbortController();
		const result = await executeCall(
			state,
			"demo_search",
			{ q: "hello" },
			"demo",
			undefined,
			controller.signal,
		);

		expect(mocks.authenticate).toHaveBeenCalledWith(
			"demo",
			"https://api.example.com/mcp",
			state.config.mcpServers.demo,
		);
		expect(manager.connect).toHaveBeenCalledTimes(1);
		expect(manager.getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
		// SDK v2 callTool(params, requestOptions) — the result-schema arg is gone.
		expect(connected.client.callTool).toHaveBeenCalledWith(
			{
				name: "search",
				arguments: { q: "hello" },
				_meta: undefined,
			},
			{ timeout: 1234 },
		);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("ok");
	});

	it("surfaces aborted proxy tool calls via the forwarded AbortSignal", async () => {
		const { executeCall } = await import("../src/proxy-modes.ts");
		const controller = new AbortController();

		const requestOptions = { signal: controller.signal, timeout: 1234 };
		const connection = {
			status: "connected",
			client: {
				callTool: mock(() => new Promise<never>(() => {})),
			},
		};
		const manager = {
			getConnection: mock(() => connection),
			getRequestOptions: mock(() => requestOptions),
			touch: mock(),
			incrementInFlight: mock(),
			decrementInFlight: mock(),
		};
		const state = {
			config: { settings: { toolPrefix: "server" }, mcpServers: { demo: { command: "demo" } } },
			manager,
			toolMetadata: new Map([
				[
					"demo",
					[
						{
							name: "demo_search",
							originalName: "search",
							description: "Search",
							inputSchema: { type: "object", properties: {} },
						},
					],
				],
			]),
			failureTracker: new Map(),
			completedUiSessions: [],
		} as any;

		const inFlight = executeCall(state, "demo_search", {}, "demo", undefined, controller.signal);
		await Promise.resolve();
		controller.abort(new Error("request aborted"));

		const result = await inFlight;

		expect(manager.getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
		expect(connection.client.callTool).toHaveBeenCalledWith(
			{ name: "search", arguments: {}, _meta: undefined },
			requestOptions,
		);
		expect(result.details).toMatchObject({ error: "call_failed", message: "request aborted" });
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
			"request aborted",
		);
	});

	it("shares one cold connect across concurrent proxy calls and applies timeout during bootstrap", async () => {
		const { executeCall } = await import("../src/proxy-modes.ts");
		const { McpServerManager } = await import("../src/server-manager.ts");

		const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
		mocks.connectImpl.mockImplementation(async () => {
			await pause();
		});
		mocks.listToolsImpl.mockImplementation(async () => {
			await pause();
			return {
				tools: [
					{
						name: "search",
						description: "Search",
						inputSchema: { type: "object", properties: {} },
					},
				],
			};
		});
		mocks.listResourcesImpl.mockImplementation(async () => {
			await pause();
			return { resources: [] };
		});
		mocks.lazyConnect.mockImplementation(async (state: any, serverName: string) => {
			const connection = await state.manager.connect(
				serverName,
				state.config.mcpServers[serverName],
			);
			if (connection.status !== "connected") {
				return false;
			}
			state.toolMetadata.set(serverName, [
				{
					name: "demo_search",
					originalName: "search",
					description: "Search",
					inputSchema: { type: "object", properties: {} },
				},
			]);
			return true;
		});

		const manager = new McpServerManager();
		manager.setDefaultRequestTimeoutMs(5000);
		const state = {
			config: {
				settings: { toolPrefix: "server" },
				mcpServers: {
					demo: { command: "node", args: ["server.js"] },
				},
			},
			manager,
			toolMetadata: new Map(),
			failureTracker: new Map(),
			completedUiSessions: [],
		} as any;

		const [first, second] = await Promise.all([
			executeCall(state, "demo_search", { q: "one" }),
			executeCall(state, "demo_search", { q: "two" }),
		]);

		expect(mocks.clients).toHaveLength(1);
		const client = mocks.clients[0];
		expect(client.connect).toHaveBeenCalledTimes(1);
		expect(client.connect).toHaveBeenCalledWith(mocks.transports[0], { timeout: 5000 });
		expect(client.listTools).toHaveBeenCalledTimes(1);
		expect(client.listTools).toHaveBeenCalledWith(undefined, { timeout: 5000 });
		expect(client.listResources).toHaveBeenCalledTimes(1);
		expect(client.listResources).toHaveBeenCalledWith(undefined, { timeout: 5000 });
		// SDK v2 callTool(params, requestOptions) — no result-schema arg.
		expect(client.callTool).toHaveBeenNthCalledWith(
			1,
			{ name: "search", arguments: { q: "one" }, _meta: undefined },
			{ timeout: 5000 },
		);
		expect(client.callTool).toHaveBeenNthCalledWith(
			2,
			{ name: "search", arguments: { q: "two" }, _meta: undefined },
			{ timeout: 5000 },
		);
		expect(first.content[0]?.type === "text" ? first.content[0].text : "").toContain("ok");
		expect(second.content[0]?.type === "text" ? second.content[0].text : "").toContain("ok");
	});
});
