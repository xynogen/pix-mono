import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

type OAuthProviderLike = {
	redirectUrl?: string;
	clientMetadata?: {
		redirect_uris?: string[];
		client_name?: string;
		client_uri?: string;
	};
};

type TransportOptions = {
	requestInit?: {
		headers?: Record<string, string>;
	};
	authProvider?: OAuthProviderLike;
};

type HttpTransportMock = {
	url: URL;
	options: TransportOptions;
	close: () => Promise<void>;
};

const mocks = {
	clients: [] as any[],
	httpTransports: [] as HttpTransportMock[],
};

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: mock((info: unknown, options: unknown) => {
		const client = {
			info,
			options,
			setRequestHandler: mock(),
			setNotificationHandler: mock(),
			connect: mock(async () => undefined),
			listTools: mock(async () => ({ tools: [] })),
			listResources: mock(async () => ({ resources: [] })),
			close: mock(async () => undefined),
		};
		mocks.clients.push(client);
		return client;
	}),
}));

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: mock(),
}));

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: mock((url: URL, options: TransportOptions) => {
		const transport = { url, options, close: mock(async () => undefined) };
		mocks.httpTransports.push(transport);
		return transport;
	}),
}));

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: mock(),
}));

mock.module("../src/npx-resolver.ts", () => ({
	resolveNpxBinary: mock(async () => null),
}));

describe("McpServerManager HTTP bearer auth", () => {
	const originalEnv = {
		MCP_TEST_BEARER_TOKEN: process.env.MCP_TEST_BEARER_TOKEN,
		MCP_TEST_BEARER_TOKEN_ENV: process.env.MCP_TEST_BEARER_TOKEN_ENV,
	};

	beforeEach(() => {
		mocks.clients.length = 0;
		mocks.httpTransports.length = 0;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it(`interpolates \${VAR} bearerToken placeholders`, async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		process.env.MCP_TEST_BEARER_TOKEN = "placeholder-token";

		const manager = new McpServerManager();
		await manager.connect("remote", {
			url: "https://example.test/mcp",
			auth: "bearer",
			bearerToken: `\${MCP_TEST_BEARER_TOKEN}`,
		});

		expect(mocks.httpTransports.at(-1)!.options.requestInit?.headers?.Authorization).toBe(
			"Bearer placeholder-token",
		);
	});

	it("interpolates $env:VAR bearerToken placeholders", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		process.env.MCP_TEST_BEARER_TOKEN = "env-prefix-token";

		const manager = new McpServerManager();
		await manager.connect("remote", {
			url: "https://example.test/mcp",
			auth: "bearer",
			bearerToken: "$env:MCP_TEST_BEARER_TOKEN",
		});

		expect(mocks.httpTransports.at(-1)!.options.requestInit?.headers?.Authorization).toBe(
			"Bearer env-prefix-token",
		);
	});

	it("keeps bearerTokenEnv support", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		process.env.MCP_TEST_BEARER_TOKEN_ENV = "named-env-token";

		const manager = new McpServerManager();
		await manager.connect("remote", {
			url: "https://example.test/mcp",
			auth: "bearer",
			bearerTokenEnv: "MCP_TEST_BEARER_TOKEN_ENV",
		});

		expect(mocks.httpTransports.at(-1)!.options.requestInit?.headers?.Authorization).toBe(
			"Bearer named-env-token",
		);
	});

	it("uses configured headers without implicit OAuth", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");

		const manager = new McpServerManager();
		await manager.connect("remote", {
			url: "https://example.test/mcp",
			headers: { "X-Goog-Api-Key": "api-key" },
		});

		expect(mocks.httpTransports.at(-1)!.options.requestInit?.headers?.["X-Goog-Api-Key"]).toBe(
			"api-key",
		);
		expect(mocks.httpTransports.at(-1)!.options.authProvider).toBeUndefined();
	});

	it("preserves OAuth redirect URI and client metadata for HTTP transports", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");

		const manager = new McpServerManager();
		await manager.connect("remote", {
			url: "https://example.test/mcp",
			auth: "oauth",
			oauth: {
				redirectUri: "http://127.0.0.1:3118/callback",
				clientName: "Custom MCP",
				clientUri: "https://example.com/custom-mcp",
			},
		});

		const authProvider = mocks.httpTransports.at(-1)!.options.authProvider;
		expect(authProvider?.redirectUrl).toBe("http://127.0.0.1:3118/callback");
		expect(authProvider?.clientMetadata?.redirect_uris).toEqual(["http://127.0.0.1:3118/callback"]);
		expect(authProvider?.clientMetadata?.client_name).toBe("Custom MCP");
		expect(authProvider?.clientMetadata?.client_uri).toBe("https://example.com/custom-mcp");
	});

	it("applies the configured timeout to the HTTP probe connect", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");

		const manager = new McpServerManager();
		manager.setDefaultRequestTimeoutMs(5000);
		await manager.connect("remote", {
			url: "https://example.test/mcp",
		});

		expect(mocks.clients[1].connect).toHaveBeenCalledWith(mocks.httpTransports[0], {
			timeout: 5000,
		});
		expect(mocks.clients[0].connect).toHaveBeenCalledWith(mocks.httpTransports[1], {
			timeout: 5000,
		});
	});
});
