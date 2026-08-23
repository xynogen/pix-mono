import { describe, expect, it, mock } from "bun:test";
import { abortable } from "../src/abort.ts";
import { createDirectToolExecutor } from "../src/direct-tools.ts";
import { lazyConnect } from "../src/init.ts";
import { executeCall, executeConnect } from "../src/proxy-modes.ts";
import { McpServerManager } from "../src/server-manager.ts";

// SDK v2 types content[0] as a TextContent | ImageContent union, so `.text`
// needs a narrow. Mirror the firstText helper used in the other test files.
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	return first && first.type === "text" ? (first.text ?? "") : "";
}

function connectedState(client: Record<string, unknown>) {
	return {
		config: {
			settings: { toolPrefix: "server" },
			mcpServers: { demo: { command: "node", args: ["server.js"] } },
		},
		manager: {
			getConnection: mock(() => ({ status: "connected", client, tools: [], resources: [] })),
			touch: mock(() => {}),
			incrementInFlight: mock(() => {}),
			decrementInFlight: mock(() => {}),
			close: mock(async () => undefined),
			getRequestOptions: mock((_server: string, signal?: AbortSignal) =>
				signal ? { signal } : undefined,
			),
		},
		toolMetadata: new Map([
			[
				"demo",
				[
					{
						name: "demo_slow",
						originalName: "slow",
						description: "Slow tool",
					},
				],
			],
		]),
		failureTracker: new Map(),
		ui: undefined,
	} as any;
}

describe("AbortSignal propagation", () => {
	it("abortable rejects promptly when the host signal aborts", async () => {
		const controller = new AbortController();
		const inFlight = abortable(new Promise<never>(() => {}), controller.signal);

		controller.abort(new Error("user cancelled"));

		await expect(inFlight).rejects.toThrow("user cancelled");
	});

	it("direct tools pass AbortSignal to MCP callTool and settle if the MCP SDK promise hangs", async () => {
		const controller = new AbortController();
		const callTool = mock(() => new Promise<never>(() => {}));
		const state = connectedState({ callTool });
		const execute = createDirectToolExecutor(
			() => state,
			() => null,
			{
				serverName: "demo",
				originalName: "slow",
				prefixedName: "demo_slow",
				description: "Slow tool",
			},
		);

		const inFlight = execute("call-1", {}, controller.signal, undefined, {} as any);
		await Promise.resolve();
		controller.abort(new Error("user cancelled"));

		const result = await inFlight;
		expect(firstText(result)).toContain("Failed to call tool: user cancelled");
		expect(result.details.error).toBe("call_failed");
		// SDK v2 callTool(params, requestOptions) — no result-schema arg.
		expect(callTool).toHaveBeenCalledWith(
			{ name: "slow", arguments: {}, _meta: undefined },
			{ signal: controller.signal },
		);
		expect(state.manager.decrementInFlight).toHaveBeenCalledWith("demo");
	});

	it("proxy tool calls pass AbortSignal to MCP callTool and settle if the MCP SDK promise hangs", async () => {
		const controller = new AbortController();
		const callTool = mock(() => new Promise<never>(() => {}));
		const state = connectedState({ callTool });

		const inFlight = executeCall(state, "demo_slow", {}, undefined, undefined, controller.signal);
		await Promise.resolve();
		controller.abort(new Error("user cancelled"));

		const result = await inFlight;
		expect(firstText(result)).toContain("Failed to call tool: user cancelled");
		expect(result.details.error).toBe("call_failed");
		// SDK v2 callTool(params, requestOptions) — no result-schema arg.
		expect(callTool).toHaveBeenCalledWith(
			{ name: "slow", arguments: {}, _meta: undefined },
			{ signal: controller.signal },
		);
		expect(state.manager.decrementInFlight).toHaveBeenCalledWith("demo");
	});

	it("proxy connect passes AbortSignal to manager.connect and does not record aborts as server failures", async () => {
		const controller = new AbortController();
		const state = {
			config: { mcpServers: { demo: { command: "node", args: ["server.js"] } } },
			manager: {
				connect: mock(async (_name: string, _definition: any, signal?: AbortSignal) => {
					controller.abort(new Error("user cancelled"));
					signal?.throwIfAborted();
					return { status: "connected", tools: [], resources: [] };
				}),
				getAllConnections: mock(() => new Map()),
			},
			toolMetadata: new Map(),
			failureTracker: new Map(),
			ui: undefined,
		} as any;

		const result = await executeConnect(state, "demo", controller.signal);

		expect(result.details.error).toBe("aborted");
		expect(state.manager.connect).toHaveBeenCalledWith(
			"demo",
			state.config.mcpServers.demo,
			controller.signal,
		);
		expect(state.failureTracker.size).toBe(0);
	});

	it("lazyConnect rethrows host aborts without updating the failure backoff", async () => {
		const controller = new AbortController();
		const state = {
			config: { mcpServers: { demo: { command: "node", args: ["server.js"] } } },
			manager: {
				getConnection: mock(() => undefined),
				connect: mock(async (_name: string, _definition: any, signal?: AbortSignal) => {
					signal?.throwIfAborted();
					return { status: "connected", tools: [], resources: [] };
				}),
			},
			toolMetadata: new Map(),
			failureTracker: new Map(),
			ui: { setStatus: mock(() => {}) },
		} as any;

		controller.abort(new Error("user cancelled"));

		await expect(lazyConnect(state, "demo", controller.signal)).rejects.toThrow("user cancelled");
		expect(state.failureTracker.size).toBe(0);
	});

	it("server-manager resource discovery does not swallow host aborts", async () => {
		const controller = new AbortController();
		const client = {
			listResources: mock(async (_params: any, options?: { signal?: AbortSignal }) => {
				options?.signal?.throwIfAborted();
				return { resources: [] };
			}),
		};
		const manager = new McpServerManager({} as any);

		controller.abort(new Error("user cancelled"));

		await expect(
			(manager as any).fetchAllResources(client, { signal: controller.signal }),
		).rejects.toThrow("user cancelled");
	});

	it("server-manager readResource passes AbortSignal through the MCP SDK request options", async () => {
		const controller = new AbortController();
		const readResource = mock(async () => ({ contents: [] }));
		const manager = new McpServerManager({} as any);
		(manager as any).connections.set("demo", {
			status: "connected",
			client: { readResource },
		});

		await manager.readResource("demo", "resource://demo", controller.signal);

		expect(readResource).toHaveBeenCalledWith(
			{ uri: "resource://demo" },
			{ signal: controller.signal },
		);
	});
});
