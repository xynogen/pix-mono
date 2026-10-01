import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MetadataCache } from "../src/metadata-cache.ts";
import type { McpExtensionState } from "../src/state.ts";
import type { McpResource, McpTool } from "../src/types.ts";

const definition = { command: "test-server", lifecycle: "eager" as const };
const connection = {
	status: "connected",
	tools: [] as McpTool[],
	resources: [] as McpResource[],
	client: { getInstructions: () => undefined },
};
let callback: ((name: string) => void) | undefined;
const manager = {
	setDefaultRequestTimeoutMs: mock(() => {}),
	setProviderTokenResolver: mock(() => {}),
	setMetadataChangedCallback: mock((fn: typeof callback) => {
		callback = fn;
	}),
	connect: mock(async () => connection),
	getConnection: mock(() => connection),
	getAllConnections: () => new Map([["demo", connection]]),
};
mock.module("../src/server-manager.ts", () => ({ McpServerManager: mock(() => manager) }));
mock.module("../src/config.ts", () => ({
	loadMcpConfig: () => ({
		mcpServers: { demo: definition },
		settings: { sampling: false, elicitation: false },
	}),
}));
mock.module("../src/lifecycle.ts", () => ({
	McpLifecycleManager: mock(() => ({
		setGlobalIdleTimeout() {},
		registerServer() {},
		setReconnectCallback() {},
		setIdleShutdownCallback() {},
		startHealthChecks() {},
	})),
}));
let cache: MetadataCache;
const realCache = await import("../src/metadata-cache.ts");
mock.module("../src/metadata-cache.ts", () => ({
	...realCache,
	loadMetadataCache: () => cache,
	getMetadataCachePath: () => import.meta.path,
	saveMetadataCache: (next: MetadataCache) => {
		cache = { version: 1, servers: { ...cache.servers, ...next.servers } };
	},
}));
const { initializeMcp, updateMetadataCache, updateServerMetadata } = await import("../src/init.ts");

beforeEach(() => {
	callback = undefined;
	connection.status = "connected";
	connection.tools = [];
	connection.resources = [];
	manager.connect.mockClear();
	manager.setMetadataChangedCallback.mockClear();
	cache = {
		version: 1,
		servers: {
			demo: {
				configHash: realCache.computeServerHash(definition),
				tools: [],
				resources: [{ name: "deleted", uri: "test://deleted" }],
				cachedAt: Date.now(),
			},
		},
	};
});

describe("dynamic MCP metadata cache", () => {
	it("does not resurrect deleted resources from a matching cache entry", () => {
		const state = {
			manager,
			config: { mcpServers: { demo: definition } },
			toolMetadata: new Map(),
		} as unknown as McpExtensionState;
		updateServerMetadata(state, "demo");
		updateMetadataCache(state, "demo");
		expect(state.toolMetadata.get("demo")).toEqual([]);
		expect(cache.servers.demo.resources).toEqual([]);
	});

	it("registers before startup connect and rebuilds metadata plus cache on change", async () => {
		connection.tools = [{ name: "old", inputSchema: { type: "object" } }];
		connection.resources = [{ name: "old", uri: "test://old" }];
		const pi = { getFlag: () => undefined } as unknown as ExtensionAPI;
		const ctx = { cwd: "/tmp", hasUI: false } as unknown as ExtensionContext;
		const state = await initializeMcp(pi, ctx);
		expect(manager.setMetadataChangedCallback).toHaveBeenCalledTimes(1);
		expect(manager.setMetadataChangedCallback.mock.invocationCallOrder[0]).toBeLessThan(
			manager.connect.mock.invocationCallOrder[0],
		);
		connection.tools = [{ name: "new", inputSchema: { type: "object" } }];
		connection.resources = [];
		callback?.("demo");
		expect(state.toolMetadata.get("demo")?.map((entry) => entry.originalName)).toEqual(["new"]);
		expect(cache.servers.demo.tools.map((entry) => entry.name)).toEqual(["new"]);
		expect(cache.servers.demo.resources).toEqual([]);
		connection.tools = [];
		callback?.("demo");
		expect(state.toolMetadata.get("demo")).toEqual([]);
		expect(cache.servers.demo.tools).toEqual([]);
	});
});
