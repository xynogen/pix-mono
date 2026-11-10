import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ServerCapabilities } from "@modelcontextprotocol/client";

interface ListChangedOptions {
	listChanged?: {
		tools?: { onChanged: (error: Error | null, tools: ReturnType<typeof tool>[] | null) => void };
		resources?: {
			onChanged: (error: Error | null, resources: ReturnType<typeof resource>[] | null) => void;
		};
	};
}

const clients: ReturnType<typeof fakeClient>[] = [];
let onCreate:
	| ((client: ReturnType<typeof fakeClient>, options: ListChangedOptions) => void)
	| undefined;

function tool(name: string) {
	return { name, inputSchema: { type: "object" as const } };
}

function resource(name: string) {
	return { name, uri: `test://${name}` };
}

function fakeClient() {
	return {
		getServerCapabilities: mock(
			(): ServerCapabilities => ({
				tools: { listChanged: true },
				resources: { listChanged: true },
			}),
		),
		setNotificationHandler: mock(),
		connect: mock(async () => {}),
		listTools: mock(async () => ({ tools: [tool("old")] })),
		listResources: mock(async () => ({ resources: [resource("old")] })),
		close: mock(async () => {}),
	};
}

const realSdk = await import("@modelcontextprotocol/client");
mock.module("@modelcontextprotocol/client", () => ({
	...realSdk,
	Client: mock((_info: unknown, options: ListChangedOptions) => {
		const client = fakeClient();
		clients.push(client);
		onCreate?.(client, options);
		return client;
	}),
}));
mock.module("@modelcontextprotocol/client/stdio", () => ({
	StdioClientTransport: mock(() => ({ close: mock(async () => {}) })),
}));

const { McpServerManager } = await import("../src/server-manager.ts");
const managers: InstanceType<typeof McpServerManager>[] = [];
const definition = { command: "test-server" };

function manager() {
	const instance = new McpServerManager();
	managers.push(instance);
	return instance;
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map((instance) => instance.closeAll()));
	clients.length = 0;
	onCreate = undefined;
});

describe("MCP list_changed refresh", () => {
	it("updates tool and resource metadata through SDK listChanged callbacks", async () => {
		let options!: ListChangedOptions;
		onCreate = (_client, value) => {
			options = value;
		};
		const instance = manager();
		const changed = mock();
		instance.setMetadataChangedCallback(changed);
		const connection = await instance.connect("demo", definition);

		options.listChanged?.tools?.onChanged(null, [tool("new-tool")]);
		options.listChanged?.resources?.onChanged(null, [resource("new-resource")]);

		expect(connection.tools.map(({ name }) => name)).toEqual(["new-tool"]);
		expect(connection.resources.map(({ name }) => name)).toEqual(["new-resource"]);
		expect(changed).toHaveBeenCalledTimes(2);
	});

	it("keeps a list change delivered during initial connection", async () => {
		onCreate = (client, options) => {
			client.connect.mockImplementation(async () => {
				options.listChanged?.tools?.onChanged(null, [tool("browser-tool")]);
			});
		};
		const instance = manager();
		const connection = await instance.connect("demo", definition);

		expect(connection.tools.map(({ name }) => name)).toEqual(["browser-tool"]);
	});

	it("keeps prior metadata and reports SDK refresh failures", async () => {
		let options!: ListChangedOptions;
		onCreate = (_client, value) => {
			options = value;
		};
		const instance = manager();
		const connection = await instance.connect("demo", definition);
		const error = spyOn(console, "error").mockImplementation(() => {});

		try {
			options.listChanged?.tools?.onChanged(new Error("list unavailable"), null);
			expect(connection.tools.map(({ name }) => name)).toEqual(["old"]);
			expect(error.mock.calls.flat().join(" ")).toContain(
				"Failed to refresh tools for demo; keeping previous list: list unavailable",
			);
		} finally {
			error.mockRestore();
		}
	});

	it("does not turn an initial resource discovery failure into an empty list", async () => {
		onCreate = (client) => {
			client.listResources.mockRejectedValue(new Error("resources failed"));
		};
		const instance = manager();

		await expect(instance.connect("demo", definition)).rejects.toThrow("resources failed");
		expect(instance.getConnection("demo")).toBeUndefined();
		expect(clients[0]?.close).toHaveBeenCalled();
	});

	it("skips listResources when the server does not advertise the resources capability", async () => {
		// Guard against the SDK console.debug("... does not advertise resources
		// capability - returning empty list") that bleeds into the TUI.
		onCreate = (client) => {
			client.getServerCapabilities.mockReturnValue({ tools: { listChanged: true } });
		};
		const instance = manager();
		const connection = await instance.connect("demo", definition);

		expect(clients[0]?.listResources).not.toHaveBeenCalled();
		expect(clients[0]?.listTools).toHaveBeenCalledTimes(1);
		expect(connection.resources).toEqual([]);
		expect(connection.tools.map(({ name }) => name)).toEqual(["old"]);
	});

	it("skips listTools when the server does not advertise the tools capability", async () => {
		onCreate = (client) => {
			client.getServerCapabilities.mockReturnValue({ resources: { listChanged: true } });
		};
		const instance = manager();
		const connection = await instance.connect("demo", definition);

		expect(clients[0]?.listTools).not.toHaveBeenCalled();
		expect(clients[0]?.listResources).toHaveBeenCalledTimes(1);
		expect(connection.tools).toEqual([]);
		expect(connection.resources.map(({ name }) => name)).toEqual(["old"]);
	});
});
