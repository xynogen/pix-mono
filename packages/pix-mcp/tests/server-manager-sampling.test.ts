import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

const mocks = {
	clients: [] as any[],
	transports: [] as any[],
	open: mock(async () => undefined),
};

mock.module("open", () => ({ default: mocks.open }));

// SDK v2 collapsed Client + HTTP/SSE transports into the single
// @modelcontextprotocol/client barrel (only stdio stays a subpath). mock.module
// is process-global, so this same barrel also feeds ProtocolError,
// ProtocolErrorCode, UrlElicitationRequiredError, etc. to other source files.
// Spread the real module and override only the classes this suite stubs, or
// those unrelated exports vanish and unrelated files fail to import.
const realClient = await import("@modelcontextprotocol/client");
mock.module("@modelcontextprotocol/client", () => ({
	...realClient,
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
	StreamableHTTPClientTransport: mock(),
	SSEClientTransport: mock(),
}));

mock.module("@modelcontextprotocol/client/stdio", () => ({
	StdioClientTransport: mock((options: unknown) => {
		const transport = {
			options,
			close: mock(async () => undefined),
		};
		mocks.transports.push(transport);
		return transport;
	}),
}));

mock.module("../src/npx-resolver.ts", () => ({
	resolveNpxBinary: mock(async () => null),
}));

describe("McpServerManager sampling", () => {
	const originalMcpTestCwd = process.env.MCP_TEST_CWD;

	beforeEach(() => {
		mocks.clients.length = 0;
		mocks.transports.length = 0;
		mocks.open.mockClear();
	});

	afterEach(() => {
		if (originalMcpTestCwd === undefined) {
			delete process.env.MCP_TEST_CWD;
		} else {
			process.env.MCP_TEST_CWD = originalMcpTestCwd;
		}
	});

	it("advertises sampling and registers the handler before connecting", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		const manager = new McpServerManager();
		manager.setSamplingConfig({
			autoApprove: true,
			modelRegistry: {} as any,
			getCurrentModel: () => undefined,
			getSignal: () => undefined,
		});

		await manager.connect("demo", { command: "node", args: ["server.js"] });

		const client = mocks.clients[0];
		expect(client.options).toEqual({
			capabilities: { sampling: {} },
			versionNegotiation: { mode: "auto" },
		});
		expect(client.setRequestHandler).toHaveBeenCalledTimes(1);
		expect(client.setRequestHandler.mock.invocationCallOrder[0]).toBeLessThan(
			client.connect.mock.invocationCallOrder[0],
		);
	});

	it("advertises elicitation capabilities and registers the handler before connecting", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		const manager = new McpServerManager();
		manager.setElicitationConfig({
			allowUrl: true,
			ui: {} as any,
		});

		await manager.connect("demo", { command: "node", args: ["server.js"] });

		const client = mocks.clients[0];
		expect(client.options).toEqual({
			capabilities: {
				elicitation: {
					form: {},
					url: {},
				},
			},
			versionNegotiation: { mode: "auto" },
		});
		expect(client.setRequestHandler).toHaveBeenCalledTimes(1);
		expect(client.setRequestHandler.mock.invocationCallOrder[0]).toBeLessThan(
			client.connect.mock.invocationCallOrder[0],
		);
	});

	it("advertises form-only elicitation when URL navigation is unavailable", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		const manager = new McpServerManager();
		manager.setElicitationConfig({ allowUrl: false, ui: {} as any });

		await manager.connect("demo", { command: "node", args: ["server.js"] });

		expect(mocks.clients[0].options).toEqual({
			capabilities: { elicitation: { form: {} } },
			versionNegotiation: { mode: "auto" },
		});
	});

	it("notifies only when a known URL elicitation completes", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		const ui = {
			select: mock().mockResolvedValue("Open"),
			input: mock(),
			notify: mock(),
		};
		const manager = new McpServerManager();
		manager.setElicitationConfig({ allowUrl: true, ui: ui as any });
		await manager.connect("demo", { command: "node", args: ["server.js"] });

		const client = mocks.clients[0];
		const requestHandler = client.setRequestHandler.mock.calls[0][1];
		await requestHandler({
			method: "elicitation/create",
			params: {
				mode: "url",
				message: "Connect",
				elicitationId: "known-id",
				url: "https://example.com/connect",
			},
		});
		const completionHandler = client.setNotificationHandler.mock.calls[0][1];
		completionHandler({ params: { elicitationId: "unknown-id" } });
		completionHandler({ params: { elicitationId: "known-id" } });
		completionHandler({ params: { elicitationId: "known-id" } });

		expect(ui.notify).toHaveBeenCalledWith("Opened browser for MCP elicitation.", "info");
		expect(ui.notify).toHaveBeenCalledWith(
			"MCP browser interaction for demo completed. You can retry the tool now.",
			"info",
		);
		expect(ui.notify).toHaveBeenCalledTimes(2);
	});

	it("handles every URL in a URL-required error", async () => {
		const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/client");
		const { McpServerManager } = await import("../src/server-manager.ts");
		const ui = {
			select: mock().mockResolvedValue("Open"),
			input: mock(),
			notify: mock(),
		};
		const manager = new McpServerManager();
		manager.setElicitationConfig({ allowUrl: true, ui: ui as any });
		const result = await manager.handleUrlElicitationRequired(
			"demo",
			new UrlElicitationRequiredError([
				{ mode: "url", message: "First", elicitationId: "one", url: "https://example.com/one" },
				{ mode: "url", message: "Second", elicitationId: "two", url: "https://example.com/two" },
			]),
		);

		expect(result).toBe("accept");
		expect(mocks.open).toHaveBeenNthCalledWith(1, "https://example.com/one");
		expect(mocks.open).toHaveBeenNthCalledWith(2, "https://example.com/two");
	});

	it("advertises sampling and elicitation together", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		const manager = new McpServerManager();
		manager.setSamplingConfig({
			autoApprove: true,
			modelRegistry: {} as any,
			getCurrentModel: () => undefined,
			getSignal: () => undefined,
		});
		manager.setElicitationConfig({
			allowUrl: true,
			ui: {} as any,
		});

		await manager.connect("demo", { command: "node", args: ["server.js"] });

		expect(mocks.clients[0].options).toEqual({
			capabilities: {
				sampling: {},
				elicitation: {
					form: {},
					url: {},
				},
			},
			versionNegotiation: { mode: "auto" },
		});
		expect(mocks.clients[0].setRequestHandler).toHaveBeenCalledTimes(2);
	});

	it("does not advertise sampling when no sampling config is set", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		const manager = new McpServerManager();

		await manager.connect("demo", { command: "node", args: ["server.js"] });

		const client = mocks.clients[0];
		// No capabilities, but mode:'auto' negotiation is always passed now.
		expect(client.options).toEqual({ versionNegotiation: { mode: "auto" } });
		expect(client.setRequestHandler).not.toHaveBeenCalled();
	});

	it("expands environment variables and tilde in stdio cwd", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		process.env.MCP_TEST_CWD = "/tmp/pi-mcp-cwd";

		const envManager = new McpServerManager();
		await envManager.connect("env-cwd", {
			command: "node",
			args: ["server.js"],
			cwd: `\${MCP_TEST_CWD}/nested`,
		});

		const homeManager = new McpServerManager();
		await homeManager.connect("home-cwd", {
			command: "node",
			args: ["server.js"],
			cwd: "~/nested",
		});

		expect(mocks.transports[0].options).toMatchObject({ cwd: "/tmp/pi-mcp-cwd/nested" });
		expect(mocks.transports[1].options).toMatchObject({ cwd: join(homedir(), "nested") });
	});

	it("uses the session cwd for stdio servers without an explicit cwd", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		const manager = new McpServerManager("/tmp/pi-session-cwd");

		await manager.connect("session-cwd", { command: "node", args: ["server.js"] });

		expect(mocks.transports[0].options).toMatchObject({ cwd: "/tmp/pi-session-cwd" });
	});

	it("prefers an explicit stdio cwd over the session cwd", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		const manager = new McpServerManager("/tmp/pi-session-cwd");

		await manager.connect("explicit-cwd", {
			command: "node",
			args: ["server.js"],
			cwd: "/tmp/server-cwd",
		});

		expect(mocks.transports[0].options).toMatchObject({ cwd: "/tmp/server-cwd" });
	});

	it("applies the global timeout to connect and discovery requests", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		const manager = new McpServerManager();
		manager.setDefaultRequestTimeoutMs(2500);

		await manager.connect("demo", { command: "node", args: ["server.js"] });

		const client = mocks.clients[0];
		expect(client.connect).toHaveBeenCalledWith(mocks.transports[0], { timeout: 2500 });
		expect(client.listTools).toHaveBeenCalledWith(undefined, { timeout: 2500 });
		expect(client.listResources).toHaveBeenCalledWith(undefined, { timeout: 2500 });
	});

	it("builds request options from the global timeout", async () => {
		const { McpServerManager } = await import("../src/server-manager.ts");
		const manager = new McpServerManager();
		manager.setDefaultRequestTimeoutMs(2500);

		await manager.connect("demo", { command: "node", args: ["server.js"] });

		const signal = new AbortController().signal;
		expect(manager.getRequestOptions("demo", signal)).toEqual({ signal, timeout: 2500 });
		expect(manager.getRequestOptions("missing", signal)).toEqual({ signal, timeout: 2500 });
		expect(manager.getRequestOptions("missing")).toEqual({ timeout: 2500 });

		manager.setDefaultRequestTimeoutMs(0);
		expect(manager.getRequestOptions("missing")).toBeUndefined();
	});
});
