import { beforeEach, describe, expect, it, mock } from "bun:test";

const mocks = {
	completeAuthFromInput: mock(
		async (_server: string, _input: string): Promise<string> => "authenticated",
	),
	startAuth: mock(
		async (
			_server: string,
			_url: string,
			_definition: unknown,
			_options?: { waitForBrowserCallback?: boolean },
		): Promise<{ authorizationUrl: string; callbackCompletion?: Promise<string> }> => ({
			authorizationUrl: "",
		}),
	),
	supportsOAuth: mock((definition: { auth?: string }): boolean => definition.auth === "oauth"),
	lazyConnect: mock(() => {}),
	updateServerMetadata: mock(() => {}),
	updateMetadataCache: mock(() => {}),
	getFailureAgeSeconds: mock(() => {}),
	updateStatusBar: mock(() => {}),
};

mock.module("../src/mcp-auth-flow.ts", () => ({
	authenticate: mock(() => {}),
	completeAuthFromInput: mocks.completeAuthFromInput,
	startAuth: mocks.startAuth,
	supportsOAuth: mocks.supportsOAuth,
}));

mock.module("../src/init.ts", () => ({
	lazyConnect: mocks.lazyConnect,
	updateServerMetadata: mocks.updateServerMetadata,
	updateMetadataCache: mocks.updateMetadataCache,
	getFailureAgeSeconds: mocks.getFailureAgeSeconds,
	updateStatusBar: mocks.updateStatusBar,
}));

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.text ?? "";
}

function createState(overrides: Record<string, unknown> = {}) {
	return {
		config: {
			settings: {},
			mcpServers: {
				demo: { url: "https://api.example.com/mcp", auth: "oauth" },
				bearer: { url: "https://api.example.com/mcp", auth: "bearer" },
			},
		},
		manager: { close: mock(async () => {}) },
		ui: { notify: mock(() => {}) },
		toolMetadata: new Map(),
		failureTracker: new Map([["demo", Date.now()]]),
		...overrides,
	} as any;
}

describe("manual OAuth proxy actions", () => {
	beforeEach(() => {
		mocks.completeAuthFromInput.mockReset().mockResolvedValue("authenticated");
		mocks.startAuth.mockReset().mockResolvedValue({
			authorizationUrl:
				"https://auth.example.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A19876%2Fcallback",
		});
		mocks.supportsOAuth
			.mockReset()
			.mockImplementation((definition: { auth?: string }) => definition.auth === "oauth");
		mocks.updateStatusBar.mockReset();
	});

	it("returns copyable instructions and authorization URL", async () => {
		const { executeAuthStart } = await import("../src/proxy-modes.ts");
		const state = createState();

		const result = await executeAuthStart(state, "demo");

		expect(mocks.startAuth).toHaveBeenCalledWith(
			"demo",
			"https://api.example.com/mcp",
			state.config.mcpServers.demo,
			{ waitForBrowserCallback: true },
		);
		expect(firstText(result)).toContain("Open this URL in your local browser");
		expect(firstText(result)).toContain("https://auth.example.com/authorize");
		expect(firstText(result)).toContain("auth-complete");
		expect(result.details).toMatchObject({ mode: "auth-start", server: "demo" });
	});

	it("finishes auth when browser reaches localhost callback", async () => {
		let completeCallback: (status: string) => void = () => {};
		const callbackCompletion = new Promise<string>((resolve) => {
			completeCallback = resolve;
		});
		mocks.startAuth.mockResolvedValueOnce({
			authorizationUrl: "https://auth.example.com/authorize",
			callbackCompletion,
		});
		const { executeAuthStart } = await import("../src/proxy-modes.ts");
		const state = createState();

		await executeAuthStart(state, "demo");
		completeCallback("authenticated");
		await callbackCompletion;
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(state.manager.close).toHaveBeenCalledWith("demo");
		expect(state.failureTracker.has("demo")).toBe(false);
		expect(mocks.updateStatusBar).toHaveBeenCalledWith(state);
	});

	it("rejects auth-start for non-OAuth servers", async () => {
		const { executeAuthStart } = await import("../src/proxy-modes.ts");

		const result = await executeAuthStart(createState(), "bearer");

		expect(mocks.startAuth).not.toHaveBeenCalled();
		expect(firstText(result)).toContain("not configured for OAuth");
		expect(result.details).toMatchObject({ error: "oauth_not_supported" });
	});

	it("completes auth from a copied redirect URL and resets connection state", async () => {
		const { executeAuthComplete } = await import("../src/proxy-modes.ts");
		const state = createState();

		const result = await executeAuthComplete(
			state,
			"demo",
			"http://localhost:19876/callback?code=abc&state=state",
		);

		expect(mocks.completeAuthFromInput).toHaveBeenCalledWith(
			"demo",
			"http://localhost:19876/callback?code=abc&state=state",
		);
		expect(state.manager.close).toHaveBeenCalledWith("demo");
		expect(state.failureTracker.has("demo")).toBe(false);
		expect(mocks.updateStatusBar).toHaveBeenCalledWith(state);
		expect(firstText(result)).toContain("OAuth authentication successful");
	});
});
