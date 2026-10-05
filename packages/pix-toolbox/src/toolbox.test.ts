import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pixRuntime } from "@xynogen/pix-runtime/config";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import registerToolbox, {
	buildRows,
	disabledFromState,
	loadedFromState,
	nextState,
	parseTargets,
	renderList,
	TOOL_STATES,
	type ToggleOps,
	type ToolRow,
	type ToolState,
	toggleTool,
} from "./toolbox.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const toolInfo = (name: string, source = "builtin", exposure = "direct") =>
	({
		name,
		exposure,
		description: `${name} does things.`,
		parameters: {},
		sourceInfo: { source, path: "", scope: "user", origin: "package" },
	}) as never;

const mcpToolInfo = (name: string) => toolInfo(name, "mcp:context7");

// ─── buildRows ──────────────────────────────────────────────────────────────

describe("buildRows", () => {
	test("excludes core tools (bash, edit, read, write)", () => {
		const rows = buildRows([
			toolInfo("bash"),
			toolInfo("edit"),
			toolInfo("read"),
			toolInfo("write"),
			toolInfo("grep"),
			toolInfo("ls"),
		]);
		expect(rows.map((r) => r.name)).toEqual(["grep", "ls"]);
		expect(rows.every((r) => !r.mcp)).toBe(true);
	});

	test("flags MCP tools", () => {
		const rows = buildRows([mcpToolInfo("ctx_search")]);
		expect((rows[0] as ToolRow).mcp).toBe(true);
	});

	test("separates deferred tools from direct tools", () => {
		const rows = buildRows([toolInfo("hunk", "extension", "deferred"), toolInfo("grep")]);
		expect(rows.map((row) => [row.name, row.exposure])).toEqual([
			["grep", "direct"],
			["hunk", "deferred"],
		]);
	});

	test("puts MCP tools after normal tools, deferred last in each group", () => {
		const rows = buildRows([
			mcpToolInfo("a_mcp"),
			toolInfo("z_tool"),
			toolInfo("b_deferred", "extension", "deferred"),
			toolInfo("c_mcp", "mcp:x", "deferred"),
		]);
		expect(rows.map((r) => r.name)).toEqual(["z_tool", "b_deferred", "a_mcp", "c_mcp"]);
	});

	test("sorts by live state (enabled, deferred, disabled), then by name", () => {
		const state: Record<string, ToolState> = {
			b_on: "enabled",
			a_off: "disabled",
			c_defer: "deferred",
			a_defer: "deferred",
			a_on: "enabled",
			m_on: "enabled",
		};
		const rows = buildRows(
			[
				toolInfo("a_off"),
				toolInfo("c_defer", "extension", "deferred"),
				mcpToolInfo("m_on"),
				toolInfo("b_on", "extension", "deferred"),
				toolInfo("a_defer", "extension", "deferred"),
				toolInfo("a_on"),
			],
			(name) => state[name] ?? "enabled",
		);
		expect(rows.map((r) => r.name)).toEqual([
			"a_on",
			"b_on",
			"a_defer",
			"c_defer",
			"a_off",
			"m_on",
		]);
	});

	test("empty input returns empty", () => {
		expect(buildRows([])).toEqual([]);
	});
});

// ─── parseTargets ───────────────────────────────────────────────────────────

describe("parseTargets", () => {
	test("splits on commas, spaces, newlines", () => {
		expect(parseTargets("ls, find  grep\nfetch")).toEqual(["ls", "find", "grep", "fetch"]);
	});

	test("dedupes", () => {
		expect(parseTargets("ls, ls")).toEqual(["ls"]);
	});

	test("empty yields empty", () => {
		expect(parseTargets("")).toEqual([]);
		expect(parseTargets("  , ")).toEqual([]);
	});
});

// ─── renderList ─────────────────────────────────────────────────────────────

describe("renderList", () => {
	const rows: ToolRow[] = [
		{ name: "grep", description: "Search files.", mcp: false },
		{ name: "hunk", description: "Review.", mcp: false, exposure: "deferred" },
		{ name: "ctx", description: "MCP search.", mcp: true, exposure: "deferred" },
	];
	const states: Record<string, ToolState> = { grep: "disabled", hunk: "deferred", ctx: "enabled" };
	const stateOf = (n: string) => states[n] ?? "enabled";

	test("groups tools and shows one state per tool", () => {
		const out = renderList(rows, stateOf);
		expect(out).toMatch(
			/^Tools:\n# disabled {2}grep .*\n~ deferred {2}hunk .*\n\nMCP:\n✓ enabled {2}ctx /,
		);
	});

	test("filters by query", () => {
		expect(renderList(rows, stateOf, "grep")).toMatch(/^Tools:\n# disabled {2}grep [^\n]*$/);
	});

	test("no match message", () => {
		expect(renderList(rows, stateOf, "zzz")).toBe('No tools matched "zzz".');
	});

	test("empty rows", () => {
		expect(renderList([], stateOf)).toBe("No tools registered.");
	});
});

// ─── toggleTool / nextState ─────────────────────────────────────────────────

describe("toggleTool", () => {
	const rows: ToolRow[] = [
		{ name: "read", description: "Read.", mcp: false },
		{ name: "grep", description: "Search.", mcp: false },
		{ name: "hunk", description: "Review.", mcp: false, exposure: "deferred" },
	];
	const makeOps = (current: ToolState) => {
		const calls: string[] = [];
		const ops: ToggleOps = {
			stateOf: () => current,
			setState: (n, s) => {
				calls.push(`${n}:${s}`);
				return s !== current;
			},
		};
		return { ops, calls };
	};

	test("sets each state and reports it", () => {
		const { ops, calls } = makeOps("enabled");
		expect(toggleTool("deferred", "hunk", rows, ops)).toMatch(/^hunk deferred — tool_search/);
		expect(toggleTool("disabled", "grep", rows, ops)).toMatch(/^grep disabled — blocked/);
		expect(calls).toEqual(["hunk:deferred", "grep:disabled"]);
	});

	test("refuses to defer a direct tool or change a core tool", () => {
		const { ops, calls } = makeOps("enabled");
		expect(toggleTool("deferred", "grep", rows, ops)).toMatch(/cannot be deferred/);
		expect(toggleTool("disabled", "read", rows, ops)).toMatch(/core tool/);
		expect(calls).toEqual([]);
	});

	test("unknown tool and same state", () => {
		const { ops } = makeOps("enabled");
		expect(toggleTool("enabled", "nope", rows, ops)).toBe('Unknown tool "nope".');
		expect(toggleTool("enabled", "grep", rows, ops)).toBe("grep is already enabled.");
	});
});

describe("nextState", () => {
	test("cycles through three states for deferred tools, two for direct tools", () => {
		const deferred: ToolRow = { name: "hunk", description: "", mcp: false, exposure: "deferred" };
		const direct: ToolRow = { name: "grep", description: "", mcp: false };
		expect(TOOL_STATES.map((s) => nextState(deferred, s))).toEqual([
			"deferred",
			"disabled",
			"enabled",
		]);
		expect(nextState(direct, "enabled")).toBe("disabled");
		expect(nextState(direct, "disabled")).toBe("enabled");
	});
});

// ─── Integration: /toolbox command ──────────────────────────────────────────

// Isolate unified settings from the user's config.
let tmpAgentDir: string;
let fixture: Awaited<ReturnType<typeof withUiFixture>>;
beforeAll(async () => {
	fixture = await withUiFixture();
	tmpAgentDir = fixture.agentDir;
});
afterAll(async () => {
	try {
		await fixture.runtime.flush();
	} finally {
		await fixture.restore();
	}
});

function makeHost(toolNames: string[], deferred: string[] = [], mcp: string[] = []) {
	const handlers: Record<string, Array<(p: unknown) => unknown>> = {};
	let active: string[] = toolNames.filter((name) => !deferred.includes(name));
	const commands: Array<{
		name: string;
		handler: (...args: unknown[]) => unknown;
	}> = [];
	const pi = {
		on(ev: string, fn: (p: unknown) => unknown) {
			if (!handlers[ev]) handlers[ev] = [];
			handlers[ev].push(fn);
		},
		emit(ev: string, payload: unknown, ctx?: unknown) {
			return Promise.all(
				(handlers[ev] ?? []).map((f) => (f as (...args: unknown[]) => unknown)(payload, ctx)),
			);
		},
		getAllTools() {
			return toolNames.map((name) => ({
				name,
				exposure: deferred.includes(name) ? "deferred" : "direct",
				description: `${name} does things.`,
				parameters: {},
				sourceInfo: { source: mcp.includes(name) ? "mcp:context7" : "builtin" },
			}));
		},
		getActiveTools() {
			return active;
		},
		setActiveTools(names: string[]) {
			active = [...names];
		},
		getCommands() {
			return [];
		},
		appendEntry() {},
		registerTool() {},
		registerCommand(name: string, def: { handler: (...args: unknown[]) => unknown }) {
			commands.push({ name, handler: def.handler });
		},
	} as never;
	const emit = (ev: string, payload: unknown, ctx?: unknown) =>
		Promise.all(
			(handlers[ev] ?? []).map((f) => (f as (...args: unknown[]) => unknown)(payload, ctx)),
		);
	return {
		pi,
		emit,
		getActive: () => active,
		command: (name: string) => commands.find((c) => c.name === name),
	};
}

function makeCtx() {
	const notes: Array<{ text: string; level?: string }> = [];
	const ctx = {
		ui: {
			notify(text: string, level?: string) {
				notes.push({ text, level });
			},
		},
	} as never;
	return { ctx, notes };
}

describe("/toolbox command", () => {
	type Note = { text: string; level?: string };
	const ALL = ["read", "write", "bash", "grep", "find"];
	const statePath = () => join(tmpAgentDir, "pix.json");

	async function boot(tools = ALL, deferred: string[] = [], mcp: string[] = []) {
		await pixRuntime().flush();
		rmSync(statePath(), { force: true });
		await pixRuntime().reload();
		const host = makeHost(tools, deferred, mcp);
		registerToolbox(host.pi);
		await host.emit("session_start", {}, {});
		return host;
	}

	test("registers a /toolbox command", async () => {
		expect((await boot()).command("toolbox")).toBeDefined();
	});

	test("deferred tools start deferred; direct tools start enabled", async () => {
		const host = await boot([...ALL, "hunk"], ["hunk"]);
		expect(host.getActive()).toEqual(ALL);
		const { ctx, notes } = makeCtx();
		await host.command("toolbox")?.handler("list", ctx);
		expect((notes[0] as Note).text).toMatch(
			/^Tools:\n✓ enabled {2}find .*\n✓ enabled {2}grep .*\n~ deferred {2}hunk [^\n]*$/,
		);
	});

	test("enable, defer and disable a deferred tool; the choice survives a new session", async () => {
		const host = await boot([...ALL, "hunk"], ["hunk"]);
		const { ctx } = makeCtx();
		await host.command("toolbox")?.handler("enable hunk", ctx);
		expect(host.getActive()).toEqual([...ALL, "hunk"]);

		await pixRuntime().flush();
		const next = makeHost([...ALL, "hunk"], ["hunk"]);
		registerToolbox(next.pi);
		await next.emit("session_start", {}, {});
		expect(next.getActive()).toEqual([...ALL, "hunk"]);

		await next.command("toolbox")?.handler("defer hunk", ctx);
		expect(next.getActive()).toEqual(ALL);
		await pixRuntime().flush();
		expect(JSON.parse(readFileSync(statePath(), "utf-8")).toolbox).toMatchObject({
			disabledTools: [],
			loadedTools: [],
		});

		await next.command("toolbox")?.handler("disable hunk", ctx);
		await pixRuntime().flush();
		expect(JSON.parse(readFileSync(statePath(), "utf-8")).toolbox).toMatchObject({
			disabledTools: ["hunk"],
		});
	});

	test("a disabled tool is blocked, and a tool_search load of it is undone", async () => {
		const host = await boot([...ALL, "hunk"], ["hunk"]);
		await host.command("toolbox")?.handler("disable hunk", makeCtx().ctx);
		const [block] = (await host.emit("tool_call", { toolName: "hunk" })) as Array<{
			block?: boolean;
		}>;
		expect(block?.block).toBe(true);
		const [allow] = await host.emit("tool_call", { toolName: "grep" });
		expect(allow).toBeUndefined();

		(host.pi as { setActiveTools(n: string[]): void }).setActiveTools([...ALL, "hunk"]); // what tool_search does
		await host.emit("tool_execution_end", { toolName: "tool_search" });
		expect(host.getActive()).toEqual(ALL);
	});

	test("bare /toolbox falls back to listing when no custom UI", async () => {
		const host = await boot();
		const { ctx, notes } = makeCtx();
		await host.command("toolbox")?.handler("", ctx);
		// core tools are excluded; the rest start enabled
		expect((notes[0] as Note).text).toMatch(
			/^Tools:\n✓ enabled {2}find .*\n✓ enabled {2}grep [^\n]*$/,
		);
	});

	test("/toolbox list <query> filters", async () => {
		const host = await boot();
		const { ctx, notes } = makeCtx();
		await host.command("toolbox")?.handler("list fin", ctx);
		expect((notes[0] as Note).text).toMatch(/^Tools:\n✓ enabled {2}find [^\n]*$/);
	});

	test("opens interactive picker when ctx.ui.custom exists", async () => {
		const host = await boot();
		let customCalled = 0;
		const notes: Note[] = [];
		const ctx = {
			ui: {
				notify(text: string, level?: string) {
					notes.push({ text, level });
				},
				async custom() {
					customCalled++;
					return null;
				},
			},
		} as never;
		await host.command("toolbox")?.handler("", ctx);
		expect(customCalled).toBe(1);
		expect(notes.length).toBe(0);
	});

	test("W1 capture: real picker states, tabs, filter and completed save", async () => {
		const host = await boot([...ALL, "hunk", "ctx_docs"], ["hunk"], ["ctx_docs"]);
		await host.command("toolbox")?.handler("disable grep", makeCtx().ctx);
		await fixture.runtime.flush();
		let renders = 0;
		let completed = false;
		try {
			await host.command("toolbox")?.handler("", {
				ui: {
					notify() {},
					custom: (
						build: (...args: any[]) => {
							render(w: number): string[];
							handleInput(d: string): void;
						},
					) =>
						new Promise<null>((resolve, reject) => {
							const view = build(
								{
									terminal: { rows: 24 },
									requestRender() {
										renders++;
									},
								},
								roleTheme(),
								undefined,
								(value: null) => {
									completed = true;
									resolve(value);
								},
							);
							try {
								const screen = (name: string) =>
									expect(captureRows(view, { width: 80, surface: "component" })).toMatchSnapshot(
										name,
									);
								screen("tools three states");
								expect(captureRows(view, { width: 120, surface: "component" })).toMatchSnapshot(
									"wide tools",
								);
								view.handleInput("\t");
								screen("MCP tab");
								view.handleInput("\x04");
								expect(host.getActive()).not.toContain("ctx_docs");
								screen("disabled status");
								view.handleInput("zzzz");
								screen("no match search");
								view.handleInput("\r");
							} catch (error) {
								reject(error);
							}
						}),
				},
			});
			expect(completed).toBe(true);
			expect(renders).toBeGreaterThan(0);
			await fixture.runtime.flush();
			expect(JSON.parse(readFileSync(statePath(), "utf-8")).toolbox.disabledTools).toEqual([
				"ctx_docs",
				"grep",
			]);
		} finally {
			await fixture.runtime.flush();
		}
	});

	test("picker: tabs split tools and MCP, ctrl keys set state, selection stays", async () => {
		const host = await boot([...ALL, "hunk", "ctx_docs"], ["hunk"], ["ctx_docs"]);
		type View = { render(w: number): string[]; handleInput(d: string): void };
		let view: View | undefined;
		const theme = {
			fg: (_c: string, s: string) => s,
			bg: (_c: string, s: string) => s,
			bold: (s: string) => s,
		};
		const ctx = {
			ui: {
				notify() {},
				async custom(f: (...a: unknown[]) => View) {
					view = f({ terminal: { rows: 40 }, requestRender() {} }, theme, undefined, () => {});
					return null;
				},
			},
		} as never;
		await host.command("toolbox")?.handler("", ctx);
		const v = view as View;
		const screen = () => v.render(100).join("\n");
		const selected = () => v.render(100).find((l) => l.includes("→")) ?? "";

		expect(screen()).toMatch(/Tools \(3\).*MCP \(1\)/);
		v.handleInput("\t");
		expect(screen()).toMatch(/ctx_docs/);
		v.handleInput("\t");

		// Rows: find, grep, hunk (deferred last). Move to hunk.
		v.handleInput("\x1b[B");
		v.handleInput("\x1b[B");
		expect(selected()).toMatch(/→ ~ hunk/);
		v.handleInput("\x05"); // ctrl+e
		expect(host.getActive()).toContain("hunk");
		expect(selected()).toMatch(/→ ✓ hunk/);
		v.handleInput("\x06"); // ctrl+f
		expect(host.getActive()).not.toContain("hunk");
		expect(selected()).toMatch(/→ ~ hunk/);
		v.handleInput("\x04"); // ctrl+d
		expect(selected()).toMatch(/→ # hunk/);
		expect(screen()).toContain("hunk disabled — blocked.");

		// Plain letters type into the search, not a state change.
		v.handleInput("d");
		expect(screen()).toMatch(/> d/);
	});
});

// ─── Persistence: disabledTools ─────────────────────────────────────────────

describe("pix.json toolbox persistence", () => {
	const statePath = () => join(tmpAgentDir, "pix.json");
	const clear = async () => {
		await pixRuntime().flush();
		rmSync(statePath(), { force: true });
		await pixRuntime().reload();
	};

	async function bootWith(tools: string[]) {
		const host = makeHost(tools);
		registerToolbox(host.pi);
		await host.emit("session_start", {}, {});
		return host;
	}

	test("first run activates every tool and writes no file", async () => {
		await clear();
		const host = await bootWith(["read", "grep", "find"]);
		expect(host.getActive()).toEqual(["read", "grep", "find"]);
		expect(existsSync(statePath())).toBe(false);
	});

	test("disable saves only the disabled tool; a tool installed later is active", async () => {
		await clear();
		const first = await bootWith(["read", "grep", "find"]);
		await first.command("toolbox")?.handler("disable grep", makeCtx().ctx);
		await pixRuntime().flush();
		expect(JSON.parse(readFileSync(statePath(), "utf-8")).toolbox).toMatchObject({
			disabledTools: ["grep"],
		});

		const next = await bootWith(["read", "grep", "find", "newtool"]);
		expect(next.getActive()).toEqual(["read", "find", "newtool"]);
	});

	test("legacy enabledTools file migrates to disabledTools", async () => {
		await clear();
		writeFileSync(
			statePath(),
			JSON.stringify({ $version: 1, toolbox: { enabledTools: ["read", "grep"] } }),
		);
		await pixRuntime().reload();
		const host = await bootWith(["read", "grep", "find"]);
		expect(host.getActive()).toEqual(["read", "grep"]);
		await pixRuntime().flush();
		expect(JSON.parse(readFileSync(statePath(), "utf-8")).toolbox).toMatchObject({
			disabledTools: ["find"],
		});
	});

	test("core tools cannot be stored as disabled", () => {
		expect(disabledFromState({ disabledTools: ["bash", "grep"] }, [])).toEqual(["grep"]);
		expect(disabledFromState({ enabledTools: [] }, ["read", "grep"])).toEqual(["grep"]);
		expect(disabledFromState({}, ["grep"])).toBeUndefined();
	});

	test("saved MCP names migrate to codemode identifiers", () => {
		const state = {
			disabledTools: ["mcp__my-srv__a-b", "web-search"],
			loadedTools: ["mcp__x__y.z"],
		};
		expect(disabledFromState(state, [])).toEqual(["mcp__my_srv__a_b", "web-search"]);
		expect(loadedFromState(state)).toEqual(["mcp__x__y_z"]);
	});

	test("saved MCP names find their hash-suffixed codemode name", () => {
		// Literal values come from pix-mcp codemodeToolName. Its tests pin the same values.
		const long = `mcp__srv__${"x".repeat(70)}`;
		const collided = "mcp__a_b__c_695274f6";
		const capped = `mcp__srv__${"x".repeat(45)}_fe6c03e8`;
		const state = { disabledTools: ["mcp__a-b__c"], loadedTools: [long] };
		expect(disabledFromState(state, [collided, capped])).toEqual([collided]);
		expect(loadedFromState(state, [collided, capped])).toEqual([capped]);
		// A server name with `__`: every split is tried, only the known name matches.
		const dunder = "mcp__a__b__c_a92700ce";
		expect(disabledFromState({ disabledTools: ["mcp__a__b__c"] }, [dunder])).toEqual([dunder]);
		// Unknown everywhere: keep the plain sanitized name.
		expect(loadedFromState({ loadedTools: ["mcp__q__r-s"] }, [dunder])).toEqual(["mcp__q__r_s"]);
	});
});
