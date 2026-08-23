import { beforeEach, describe, expect, it, mock } from "bun:test";

const mocks = {
	lazyConnect: mock(),
	getFailureAgeSeconds: mock(),
	authenticate: mock(),
	supportsOAuth: mock(),
};

mock.module("../src/init.ts", () => ({
	lazyConnect: mocks.lazyConnect,
	getFailureAgeSeconds: mocks.getFailureAgeSeconds,
}));

mock.module("../src/mcp-auth-flow.ts", () => ({
	authenticate: mocks.authenticate,
	supportsOAuth: mocks.supportsOAuth,
}));

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content[0];
	return content?.type === "text" ? (content.text ?? "") : "";
}

describe("direct tools auto auth", () => {
	beforeEach(() => {
		mocks.lazyConnect.mockReset();
		mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
		mocks.authenticate.mockReset().mockResolvedValue("authenticated");
		mocks.supportsOAuth.mockReset().mockReturnValue(true);
	});

	it("auto-authenticates and retries direct tool execution once", async () => {
		const { createDirectToolExecutor } = await import("../src/direct-tools.ts");

		let connection: any = { status: "needs-auth" };
		const connected = {
			status: "connected",
			client: {
				callTool: mock(async () => ({
					isError: false,
					content: [{ type: "text", text: "ok" }],
				})),
			},
		};

		mocks.lazyConnect
			.mockImplementationOnce(async () => false)
			.mockImplementationOnce(async () => {
				connection = connected;
				return true;
			});

		const state = {
			config: {
				settings: { autoAuth: true },
				mcpServers: {
					demo: { url: "https://api.example.com/mcp", auth: "oauth" },
				},
			},
			manager: {
				close: mock(async () => {
					connection = undefined;
				}),
				getConnection: mock(() => connection),
				getRequestOptions: mock(() => ({ timeout: 4321 })),
				touch: mock(),
				incrementInFlight: mock(),
				decrementInFlight: mock(),
			},
			failureTracker: new Map(),
			ui: { setStatus: mock() },
			completedUiSessions: [],
		} as any;

		const executor = createDirectToolExecutor(
			() => state,
			() => null,
			{
				serverName: "demo",
				originalName: "search",
				prefixedName: "demo_search",
				description: "Search",
			},
		);

		const controller = new AbortController();
		const result = await executor(
			"id",
			{ q: "hello" },
			controller.signal,
			() => {},
			undefined as any,
		);

		expect(mocks.authenticate).toHaveBeenCalledWith(
			"demo",
			"https://api.example.com/mcp",
			state.config.mcpServers.demo,
		);
		expect(state.manager.close).toHaveBeenCalledWith("demo");
		expect(state.manager.getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
		// SDK v2 callTool(params, requestOptions) — no result-schema arg.
		expect(connected.client.callTool).toHaveBeenCalledWith(
			{
				name: "search",
				arguments: { q: "hello" },
				_meta: undefined,
			},
			{ timeout: 4321 },
		);
		expect(firstText(result)).toContain("ok");
	});

	it("surfaces aborted direct tool calls via the forwarded AbortSignal", async () => {
		const { createDirectToolExecutor } = await import("../src/direct-tools.ts");
		const controller = new AbortController();

		const requestOptions = { signal: controller.signal, timeout: 4321 };
		const connection = {
			status: "connected",
			client: {
				callTool: mock(() => new Promise<never>(() => {})),
			},
		};
		const state = {
			config: { settings: {}, mcpServers: { demo: { command: "demo" } } },
			manager: {
				getConnection: mock(() => connection),
				getRequestOptions: mock(() => requestOptions),
				touch: mock(),
				incrementInFlight: mock(),
				decrementInFlight: mock(),
			},
			failureTracker: new Map(),
			completedUiSessions: [],
		} as any;
		mocks.lazyConnect.mockResolvedValue(true);

		const executor = createDirectToolExecutor(
			() => state,
			() => null,
			{
				serverName: "demo",
				originalName: "search",
				prefixedName: "demo_search",
				description: "Search",
			},
		);

		const inFlight = executor("id", {}, controller.signal, undefined, undefined as any);
		await Promise.resolve();
		controller.abort(new Error("request aborted"));

		const result = await inFlight;

		expect(state.manager.getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
		expect(connection.client.callTool).toHaveBeenCalledWith(
			{ name: "search", arguments: {}, _meta: undefined },
			requestOptions,
		);
		expect(result.details).toMatchObject({ error: "call_failed", server: "demo" });
		expect(firstText(result)).toContain("request aborted");
	});

	it("fails fast in non-ui context for browser-based OAuth", async () => {
		const { createDirectToolExecutor } = await import("../src/direct-tools.ts");

		const state = {
			config: {
				settings: { autoAuth: true },
				mcpServers: {
					demo: { url: "https://api.example.com/mcp", auth: "oauth" },
				},
			},
			manager: {
				close: mock(async () => {}),
				getConnection: mock(() => ({ status: "needs-auth" })),
				touch: mock(),
				incrementInFlight: mock(),
				decrementInFlight: mock(),
			},
			failureTracker: new Map(),
			ui: undefined,
			completedUiSessions: [],
		} as any;

		mocks.lazyConnect.mockResolvedValue(false);

		const executor = createDirectToolExecutor(
			() => state,
			() => null,
			{
				serverName: "demo",
				originalName: "search",
				prefixedName: "demo_search",
				description: "Search",
			},
		);

		const result = await executor("id", {}, undefined as any, () => {}, undefined as any);

		expect(mocks.authenticate).not.toHaveBeenCalled();
		expect(firstText(result)).toContain("auth-start");
		expect(firstText(result)).toContain("open /mcp");
	});

	it("runs URL elicitations returned by a URL-required tool error", async () => {
		const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/client");
		const { createDirectToolExecutor } = await import("../src/direct-tools.ts");
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
		const state = {
			config: { settings: {}, mcpServers: { demo: { command: "demo" } } },
			manager: {
				getConnection: mock(() => connection),
				handleUrlElicitationRequired: mock().mockResolvedValue("accept"),
				touch: mock(),
				incrementInFlight: mock(),
				decrementInFlight: mock(),
			},
			failureTracker: new Map(),
			completedUiSessions: [],
		} as any;
		mocks.lazyConnect.mockResolvedValue(true);

		const executor = createDirectToolExecutor(
			() => state,
			() => null,
			{
				serverName: "demo",
				originalName: "search",
				prefixedName: "demo_search",
				description: "Search",
			},
		);
		const result = await executor("id", {}, undefined, undefined, undefined as any);

		expect(state.manager.handleUrlElicitationRequired).toHaveBeenCalledWith("demo", error);
		expect(result.details).toMatchObject({ error: "url_elicitation_required", action: "accept" });
		expect(firstText(result)).toContain("retry the tool");
	});

	it("uses custom authRequiredMessage in non-ui direct tool auth failures", async () => {
		const { createDirectToolExecutor } = await import("../src/direct-tools.ts");

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
				close: mock(async () => {}),
				getConnection: mock(() => ({ status: "needs-auth" })),
				touch: mock(),
				incrementInFlight: mock(),
				decrementInFlight: mock(),
			},
			failureTracker: new Map(),
			ui: undefined,
			completedUiSessions: [],
		} as any;

		mocks.lazyConnect.mockResolvedValue(false);

		const executor = createDirectToolExecutor(
			() => state,
			() => null,
			{
				serverName: "demo",
				originalName: "search",
				prefixedName: "demo_search",
				description: "Search",
			},
		);

		const result = await executor("id", {}, undefined as any, () => {}, undefined as any);

		expect(mocks.authenticate).not.toHaveBeenCalled();
		expect(firstText(result)).toBe("Reconnect demo from the host app.");
	});
});
