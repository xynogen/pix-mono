import { describe, expect, it, mock } from "bun:test";

const mocks = {
	authenticate: mock(
		async (
			_name: string,
			_url: string,
			_definition: unknown,
			_options?: { onAuthorizationUrl?: (authorizationUrl: string) => void | Promise<void> },
		): Promise<string> => "authenticated",
	),
	lazyConnect: mock(async (_state: unknown, _serverName: string): Promise<boolean> => true),
	removeAuth: mock((_serverName: string): void => {}),
};

mock.module("../src/mcp-auth-flow.ts", () => ({
	authenticate: mocks.authenticate,
	removeAuth: mocks.removeAuth,
	supportsOAuth: (definition: { url?: string; auth?: string }) =>
		Boolean(definition.url) && definition.auth !== "bearer",
}));

mock.module("../src/init.ts", () => ({
	getFailureAgeSeconds: mock(() => null),
	lazyConnect: mocks.lazyConnect,
	updateMetadataCache: mock(() => {}),
	updateStatusBar: mock(() => {}),
}));

describe("authenticateServer", () => {
	it("surfaces the exact OAuth URL and reconnects the server", async () => {
		const authorizationUrl =
			"https://auth.example.com/authorize?resource=https%3A%2F%2Fmcp.sentry.dev%2Fmcp";
		mocks.authenticate.mockImplementationOnce(async (_name, _url, _definition, options) => {
			await options?.onAuthorizationUrl?.(authorizationUrl);
			return "authenticated";
		});
		mocks.lazyConnect.mockResolvedValueOnce(true);
		const ui = { notify: mock(() => {}), setStatus: mock(() => {}) };
		const close = mock().mockResolvedValue(undefined);
		const state = {
			config: {
				mcpServers: {
					sentry: { url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
				},
			},
			manager: { close },
			failureTracker: new Map(),
		};
		const { authenticateServer } = await import("../src/commands.ts");

		const result = await authenticateServer(
			"sentry",
			state as any,
			{
				hasUI: true,
				ui,
			} as any,
		);

		expect(result.ok).toBe(true);
		expect(mocks.authenticate).toHaveBeenCalledWith(
			"sentry",
			"https://mcp.sentry.dev/mcp",
			{ url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
			{ onAuthorizationUrl: expect.any(Function) },
		);
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(authorizationUrl), "info");
		expect(close).toHaveBeenCalledWith("sentry");
		expect(mocks.lazyConnect).toHaveBeenCalledWith(state, "sentry");
		expect(result.message).toContain("authenticated and connected");
	});
});
