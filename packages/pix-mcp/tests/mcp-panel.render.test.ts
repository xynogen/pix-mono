import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import type { McpDiscoverySummary } from "../src/config.ts";
import type { McpAddPanel } from "../src/mcp-add-panel.ts";
import type { McpSetupPanel } from "../src/mcp-setup-panel.ts";
import type { McpConfig, McpPanelCallbacks } from "../src/types.ts";

// ponytail: component captures preserve modal frames. Full-screen placement belongs to the host lane.
test("MCP server, add/edit, and setup modals preserve states and overflow", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	const panels: Array<{ dispose(): void }> = [];
	const captures: Record<string, string[]> = {};
	const theme = roleTheme();
	let rendered: (() => void) | undefined;
	const tui = { terminal: { rows: 40 }, requestRender: () => rendered?.() };
	const forbidden = () => {
		throw new Error("External action forbidden in modal capture");
	};
	let pending: { resolve(value: any): void; value: unknown; completed: Promise<void> } | undefined;
	const errors: unknown[] = [];
	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((done) => {
			resolve = done;
		});
		// Observe rejection before cleanup awaits the same promise and reports its error.
		void promise.catch(() => {});
		return { promise, resolve };
	}
	function capture(name: string, component: { render(width: number): string[] }, width = 80) {
		fixture.setWidth(width);
		captures[name] = captureRows(component, { width, surface: "component" });
	}
	try {
		const { createMcpPanel } = await import("../src/mcp-panel.ts");
		const { createMcpAddPanel } = await import("../src/mcp-add-panel.ts");
		const { createMcpSetupPanel } = await import("../src/mcp-setup-panel.ts");
		const config: McpConfig = {
			mcpServers: {
				docs: { command: "never-run" },
				imported: { command: "never-run", directTools: true },
				off: { command: "never-run", enabled: false },
				auth: { url: "https://example.invalid/mcp", auth: "oauth" },
				failed: { command: "never-run" },
			},
		};
		let auth = deferred<{ ok: boolean; message?: string }>();
		let authStatus: "needs-auth" | "connected" = "needs-auth";
		const callbacks: McpPanelCallbacks = {
			reconnect: forbidden,
			disconnect: forbidden,
			canAuthenticate: () => true,
			authenticate: () => auth.promise,
			getConnectionStatus: (name) =>
				name === "auth" ? authStatus : name === "failed" ? "failed" : "idle",
			refreshCacheAfterReconnect: () => null,
		};
		const empty = createMcpPanel({ mcpServers: {} }, null, new Map(), callbacks, tui, forbidden, {
			theme,
		});
		panels.push(empty);
		capture("servers-empty", empty);
		const panel = createMcpPanel(
			config,
			{
				version: 1,
				servers: {
					docs: {
						configHash: "fixture",
						cachedAt: 1,
						resources: [],
						tools: [
							{
								name: "search",
								description:
									"Search records with a long description that must wrap below the tool name and retain its hanging indent.",
							},
							{ name: "list", description: "List records" },
						],
					},
					imported: {
						configHash: "fixture",
						cachedAt: 1,
						resources: [],
						tools: [{ name: "read", description: "Read records" }],
					},
				},
			},
			new Map([["imported", { path: "<agent>/mcp.json", kind: "import", importKind: "cursor" }]]),
			callbacks,
			tui,
			() => {},
			{ theme },
		);
		panels.push(panel);
		capture("servers-mixed", panel);
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		capture("servers-expanded", panel);
		capture("servers-expanded-wide", panel, 120);
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		panel.handleInput("\x1b");
		capture("keep-selected", panel);
		panel.handleInput("\t");
		capture("discard-selected", panel);
		panel.handleInput("n");
		panel.handleInput("?");
		for (const character of "records") panel.handleInput(character);
		capture("description-filter", panel);
		panel.handleInput("\x1b");
		for (const character of "auth") panel.handleInput(character);
		capture("name-filter", panel);
		panel.handleInput("\r");
		capture("auth-busy", panel);
		let repaint = deferred<void>();
		rendered = () => repaint.resolve();
		pending = { resolve: auth.resolve, value: { ok: false }, completed: repaint.promise };
		auth.resolve({ ok: false, message: "browser disabled by fixture" });
		await repaint.promise;
		pending = undefined;
		capture("auth-failed", panel);
		auth = deferred();
		panel.handleInput("\x01");
		repaint = deferred();
		rendered = () => repaint.resolve();
		pending = { resolve: auth.resolve, value: { ok: false }, completed: repaint.promise };
		authStatus = "connected";
		auth.resolve({ ok: true });
		await repaint.promise;
		pending = undefined;
		capture("auth-complete", panel);
		// ponytail: 18 inert servers exceed the 80×24 modal body without a live MCP client.
		tui.terminal.rows = 24;
		const constrained = createMcpPanel(
			{
				mcpServers: Object.fromEntries(
					Array.from({ length: 18 }, (_, i) => [
						`server-${String(i + 1).padStart(2, "0")}`,
						{ command: "never-run" },
					]),
				),
			},
			null,
			new Map(),
			{
				reconnect: forbidden,
				disconnect: forbidden,
				canAuthenticate: () => false,
				authenticate: forbidden,
				getConnectionStatus: () => "idle",
				refreshCacheAfterReconnect: forbidden,
			},
			tui,
			forbidden,
			{ theme },
		);
		panels.push(constrained);
		capture("servers-constrained", constrained);
		constrained.handleInput("\x1b[6~");
		capture("servers-constrained-next", constrained);
		constrained.handleInput("\x1b[5~");
		expect(captureRows(constrained, { width: 80, surface: "component" })).toEqual(
			captures["servers-constrained"],
		);
		for (let i = 0; i < 4; i++) {
			constrained.handleInput("\x1b[C");
			constrained.render(80);
		}
		capture("servers-constrained-last", constrained);
		for (const [name, page, first, count] of [
			["servers-constrained", 1, 1, 6],
			["servers-constrained-next", 2, 3, 8],
			["servers-constrained-last", 5, 12, 7],
		] as const) {
			const rows = captures[name];
			expect(rows).toHaveLength(19);
			expect(rows.map((row) => visibleWidth(row.replace(/<[^>]+>/g, "")))).toEqual(
				Array(19).fill(80),
			);
			expect(rows[5]).toContain(`PageUp/PageDown inspect • ${page}/5`);
			expect([...rows.join("\n").matchAll(/server-\d{2}/g)].map(([name]) => name)).toEqual(
				Array.from({ length: count }, (_, i) => `server-${String(first + i).padStart(2, "0")}`),
			);
			expect(rows.slice(0, 5)).toEqual(captures["servers-constrained"].slice(0, 5));
			expect(rows.slice(-5)).toEqual(captures["servers-constrained"].slice(-5));
			expect(rows[0]).toBe(captures["auth-complete"][0]);
			expect(rows.at(-1)).toBe(captures["auth-complete"].at(-1));
		}
		for (let i = 0; i < 4; i++) {
			constrained.handleInput("\x1b[D");
			constrained.render(80);
		}
		expect(captureRows(constrained, { width: 80, surface: "component" })).toEqual(
			captures["servers-constrained"],
		);
		tui.terminal.rows = 40;

		const preview = {
			path: "<project>/.mcp.json",
			existed: true,
			changed: true,
			beforeText: "{}",
			afterText: "{}",
			diffText: "--- before\n+++ after\n- old\n+ new\n  context",
		};
		const connect = deferred<"connected" | "needs-auth" | "failed">();
		const finished = deferred<void>();
		let writes = 0;
		const addCallbacks = {
			resolveTargetPath: (scope: string) =>
				scope === "global" ? "<agent>/mcp.json" : "<project>/.mcp.json",
			previewEntry: () => preview,
			writeEntry: () => {
				writes++;
				return preview.path;
			},
			isNameTaken: () => false,
			testConnect: () => connect.promise,
		};
		let add: McpAddPanel = createMcpAddPanel(
			{ cwd: "<project>", callbacks: addCallbacks },
			tui,
			() => finished.resolve(),
			theme,
		);
		panels.push(add);
		capture("transport", add);
		add.handleInput("\r");
		capture("stdio-form", add);
		add.handleInput("\r");
		capture("validation-error", add);
		expect(add.getError()).toBe("Server name is required.");
		add.setFieldValue("name", "docs");
		add.setFieldValue("command", "never-run");
		add.setFieldValue("directTools", "true");
		add.setFieldValue("exposeResources", "true");
		capture("stdio-opt-in", add);
		add.handleInput("\r");
		capture("scope", add);
		add.handleInput("\r");
		capture("write-preview", add);
		pending = { resolve: connect.resolve, value: "failed", completed: finished.promise };
		add.handleInput("\r");
		capture("connection-pending", add);
		connect.resolve("connected");
		await finished.promise;
		pending = undefined;
		expect(writes).toBe(1);
		add = createMcpAddPanel(
			{
				cwd: "<project>",
				callbacks: addCallbacks,
				edit: {
					name: "remote",
					targetPath: preview.path,
					entry: {
						url: "https://example.invalid/mcp",
						bearerToken: "not-a-real-token",
						description: "Remote records",
						timeout: 30,
						enabled: false,
					},
				},
			},
			tui,
			() => {},
			theme,
		);
		panels.push(add);
		capture("http-edit-masked", add);
		expect(captures["http-edit-masked"].join("\n")).not.toContain("not-a-real-token");
		add.handleInput("\r");
		capture("edit-preview", add);

		const discovery: McpDiscoverySummary = {
			sources: [],
			imports: [],
			hasAnyConfig: false,
			hasAnyDetectedPaths: false,
			hasSharedServers: false,
			hasPiOwnedServers: false,
			totalServerCount: 0,
			fingerprint: "fixture",
			repoPrompt: { configured: false },
		};
		let work = deferred<{ path: string }>();
		const setupCallbacks = {
			previewImports: () => preview,
			previewStarterProject: () => preview,
			previewRepoPrompt: () => preview,
			adoptImports: forbidden,
			scaffoldProjectConfig: () => work.promise,
			addRepoPrompt: forbidden,
			openPath: forbidden,
			markSetupCompleted() {},
		};
		let setup: McpSetupPanel = createMcpSetupPanel(
			discovery,
			setupCallbacks,
			{
				mode: "empty",
				onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false },
			},
			tui,
			() => {},
			theme,
		);
		panels.push(setup);
		capture("setup-empty", setup);
		setup.handleInput("\r");
		capture("setup-example", setup);
		setup.handleInput("\x1b[B");
		capture("starter-preview", setup);
		setup.handleInput("\r");
		capture("setup-busy", setup);
		repaint = deferred();
		rendered = () => repaint.resolve();
		pending = {
			resolve: work.resolve,
			value: { path: "<project>/.mcp.json" },
			completed: repaint.promise,
		};
		work.resolve({ path: "<project>/.mcp.json" });
		await repaint.promise;
		pending = undefined;
		capture("setup-success", setup);
		setup.handleInput("\x1b[B");
		capture("precedence", setup);
		work = deferred();
		const rich: McpDiscoverySummary = {
			...discovery,
			hasAnyConfig: true,
			hasAnyDetectedPaths: true,
			imports: [{ kind: "cursor", path: "<home>/.cursor/mcp.json", serverCount: 2 }],
			sources: [
				{
					id: "shared-project",
					kind: "shared",
					scope: "project",
					label: "Project",
					path: "<project>/.mcp.json",
					exists: true,
					serverCount: 2,
				},
			],
			totalServerCount: 2,
			repoPrompt: {
				configured: false,
				executablePath: "<home>/RepoPrompt/cli",
				targetPath: preview.path,
				serverName: "repoprompt",
				entry: { command: "never-run" },
			},
		};
		setup = createMcpSetupPanel(
			rich,
			setupCallbacks,
			{
				mode: "setup",
				onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false },
			},
			tui,
			() => {},
			theme,
		);
		panels.push(setup);
		capture("detected-imports", setup);
		setup.handleInput("\r");
		capture("selected-import-preview", setup);
		setup.handleInput(" ");
		capture("unselected-import-preview", setup);
		setup.handleInput("\r");
		capture("import-validation", setup);
		setup.handleInput("\x1b");
		for (let i = 0; i < 3; i++) setup.handleInput("\x1b[B");
		setup.handleInput("\r");
		capture("detected-paths", setup);
		setup.handleInput("\x1b");
		setup.handleInput("\x1b[B");
		capture("repoprompt-preview", setup);
		tui.terminal.rows = 24;
		capture("setup-constrained", setup);
		expect(captures).toMatchSnapshot();
	} catch (error) {
		errors.push(error);
	} finally {
		try {
			if (pending) {
				pending.resolve(pending.value);
				await pending.completed;
			}
		} catch (error) {
			errors.push(error);
		} finally {
			try {
				for (const panel of panels) {
					try {
						panel.dispose();
					} catch (error) {
						errors.push(error);
					}
				}
			} finally {
				rendered = undefined;
				await fixture.restore().catch((error) => errors.push(error));
			}
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "MCP modal capture and cleanup failed");
});
