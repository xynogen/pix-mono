import { expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { benchlm, modelgrep } from "@xynogen/pix-data";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import {
	__resetAgentRunnersForTests,
	__setRunAgentForTests,
	AgentManager,
} from "../src/agent-manager.ts";
import type { RunOptions, RunResult } from "../src/agent-runner.ts";
import {
	getAgentConfig,
	getAllTypes,
	isDefaultsDisabled,
	registerAgents,
	setDefaultsDisabled,
} from "../src/agent-types.ts";
import registerPixSubagent from "../src/index.ts";
import {
	type AgentActivity,
	type AgentDetails,
	createAgentInfoTool,
	createAgentResultTool,
	createAgentSteerTool,
	formatContext,
} from "../src/tools.ts";
import type { AgentConfig, AgentRecord, NotificationDetails } from "../src/types.ts";
import { registerNotificationRenderer } from "../src/ui/notification.ts";
import { AgentWidget, type UICtx } from "../src/ui/widget.ts";

const NOW = 1_800_000_000_000;
const usage = { input: 1_000, output: 550, cacheWrite: 50 };
const contextUsage = { tokens: 12_400, contextWindow: 100_000, percent: 12.4 };
const statuses = ["completed", "steered", "stopped", "aborted", "error"] as const;
const theme = roleTheme();

function record(status: AgentRecord["status"] = "running"): AgentRecord {
	return {
		id: "agent-one",
		type: "Explore",
		description: "Check",
		status,
		startedAt: NOW - 12_000,
		completedAt: status === "running" || status === "queued" ? undefined : NOW,
		toolUses: 3,
		turnCount: 5,
		maxTurns: 8,
		compactionCount: 1,
		streamingMs: 10_000,
		lifetimeUsage: { ...usage },
		invocation: { modelName: "test/model-one" },
		isBackground: true,
		error: status === "error" ? "provider unavailable" : undefined,
		session: { getSessionStats: () => ({ tokens: usage, contextUsage }), dispose() {} } as never,
	};
}

// ponytail: one JSON row per capture keeps the package budget small without discarding terminal whitespace.
// Ceiling: local components and the checked self shell only. Full-screen composition needs a host integration test.
function capture(
	label: string,
	component: { render(width: number): string[] } | undefined,
	width = 80,
	surface: "component" | "host-self" = "host-self",
) {
	if (!component) throw new Error(`Missing renderer: ${label}`);
	return JSON.stringify({
		label,
		width,
		surface,
		rows: captureRows(component, { width, surface }),
	});
}

function saveRegistry() {
	const disabled = isDefaultsDisabled();
	const agents = new Map(getAllTypes().map((name) => [name, getAgentConfig(name) as AgentConfig]));
	return () => {
		setDefaultsDisabled(true);
		registerAgents(agents);
		setDefaultsDisabled(disabled);
	};
}

test("captures registered agent, control and utility render states", async () => {
	const fixture = await withUiFixture();
	const restoreRegistry = saveRegistry();
	const cwd = process.cwd();
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const clock = spyOn(Date, "now").mockReturnValue(NOW);
	const bench = spyOn(benchlm, "getCached").mockReturnValue([]);
	const models = spyOn(modelgrep, "getCached").mockReturnValue([]);
	const tools = new Map<string, ReturnType<typeof createAgentInfoTool>>();
	const host = {
		registerTool(tool: ReturnType<typeof createAgentInfoTool>) {
			tools.set(tool.name, tool);
		},
		registerMessageRenderer() {},
		on() {},
	};
	const cleanup = (
		globalThis as unknown as { "__pix-subagentCleanup": WeakMap<object, () => void> }
	)["__pix-subagentCleanup"];
	__setRunAgentForTests(async () => {
		throw new Error("Capture must not run agents");
	});
	try {
		process.chdir(fixture.agentDir);
		process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
		setDefaultsDisabled(false);
		registerPixSubagent(host as never);
		expect([...tools.keys()]).toEqual(["agent", "agent_control"]);
		const agent = tools.get("agent")!;
		const control = tools.get("agent_control")!;
		const lifecycleState: { collapsed?: boolean; timer?: ReturnType<typeof setTimeout> } = {};
		for (const [executionStarted, isPartial, isError, role] of [
			[false, true, false, "muted"],
			[true, true, false, "warning"],
			[true, false, false, "success"],
			[true, false, true, "error"],
		] as const) {
			const lines = captureRows(
				agent.renderCall!(
					{ type: "Explore" },
					theme as never,
					{
						state: lifecycleState,
						executionStarted,
						isPartial,
						isError,
						expanded: false,
						invalidate() {},
					} as never,
				),
				{ width: 80, surface: "component" },
			);
			expect(lines[0]).toStartWith(`<${role}>`);
		}
		expect(lifecycleState.timer).toBeUndefined();
		expect(
			agent.renderCall!(
				{},
				theme as never,
				{ state: { collapsed: true }, isPartial: false, expanded: false, invalidate() {} } as never,
			).render(80),
		).toEqual([]);
		const captures: string[] = [];
		const state = { collapsed: false };
		const ctx = (expanded = false, isError = false) =>
			({ state, expanded, isError, invalidate() {} }) as never;
		const args = {
			type: "Explore",
			description: "Check",
			model: "test/model-one",
			prompt: "Read the source.  \nKeep the contracts.",
		};
		const highlighted = Promise.withResolvers<void>();
		const open = agent.renderCall?.(
			args as never,
			theme as never,
			{ state, expanded: false, invalidate: highlighted.resolve } as never,
		);
		await highlighted.promise;
		captures.push(capture("agent call open", open));
		await fixture.runtime.update(collapseSection, (current) => ({
			...current,
			enabled: true,
			tools: {},
		}));
		state.collapsed = true;
		captures.push(
			capture("agent call collapsed", agent.renderCall?.(args as never, theme as never, ctx())),
		);
		captures.push(
			capture("agent call expanded", agent.renderCall?.(args as never, theme as never, ctx(true))),
		);
		const result = (details?: unknown, text = "Output  \n\nLast line  ") => ({
			content: [{ type: "text" as const, text }],
			details,
		});
		const details = (status: AgentDetails["status"]): AgentDetails => ({
			displayName: "Explore",
			description: "Check",
			subagentType: "Explore",
			modelName: "test/model-one",
			toolUses: 3,
			turnCount: 5,
			maxTurns: 8,
			context: formatContext(contextUsage),
			outputTokens: 550,
			streamingMs: 10_000,
			durationMs: 12_000,
			spinnerFrame: 0,
			activity: "reading…",
			status,
			error: status === "error" ? "provider unavailable" : undefined,
		});
		const render = (
			tool: typeof agent,
			value: ReturnType<typeof result>,
			expanded = false,
			isPartial = false,
			isError = false,
		) =>
			tool.renderResult?.(
				value as never,
				{ expanded, isPartial },
				theme as never,
				ctx(expanded, isError),
			);
		for (const status of ["running", "queued", ...statuses] as const) {
			captures.push(
				capture(
					`agent ${status} compact`,
					render(agent, result(details(status)), false, status === "running"),
				),
			);
			if (statuses.includes(status as never))
				captures.push(
					capture(`agent ${status} expanded`, render(agent, result(details(status)), true)),
				);
		}
		for (const status of ["aborted", "stopped"] as const)
			captures.push(
				capture(
					`agent ${status} host error`,
					render(agent, result(details(status)), true, false, true),
				),
			);
		captures.push(
			capture(
				"agent metadata-free error",
				render(agent, result(undefined, "spawn failed  "), true, false, true),
			),
		);
		const overflow = render(
			agent,
			result(details("completed"), Array.from({ length: 51 }, (_, i) => `line ${i}  `).join("\n")),
			true,
		)!;
		const overflowRows = captureRows(overflow, { width: 80, surface: "host-self" });
		expect(overflowRows).toHaveLength(55);
		expect(overflowRows[53]?.trimEnd()).toBe("<dim>  line 50  </dim>");
		captures.push(
			JSON.stringify({
				label: "agent detail cap",
				rows: overflowRows,
			}),
		);
		for (const kind of ["types", "models", "active"] as const) {
			const text =
				kind === "types"
					? "Available agent types:\n- Explore: Read source (tools:read,grep)\n\nUse one type."
					: kind === "models"
						? "Current parent: test/model-one\n\nAvailable models:\ntest/model-one  — 100k ctx\n\nOmit model to inherit."
						: "Agents:\nagent-one  — running · Explore [test/model-one] · Check\n\nPass an ID to agent_control.";
			const value = result(
				{
					_type: "agent-info",
					kind,
					count: 1,
					...(kind === "active"
						? {
								rows: [
									{
										id: "agent-one",
										status: "running",
										type: "Explore",
										modelName: "test/model-one",
										description: "Check",
									},
								],
								guidance: "Pass an ID to agent_control.",
							}
						: {}),
				},
				text,
			);
			captures.push(capture(`info ${kind} compact`, render(control, value)));
			captures.push(capture(`info ${kind} expanded`, render(control, value, true)));
		}
		for (const status of ["running", "queued", ...statuses, "not-found"] as const) {
			const value = result({
				_type: "agent-result",
				agentId: "agent-one",
				status,
				verbose: false,
				hasOutput: true,
			});
			captures.push(capture(`result ${status} compact`, render(control, value)));
			captures.push(
				capture(
					`result ${status} expanded`,
					render(control, value, true, false, status === "stopped" || status === "aborted"),
				),
			);
		}
		for (const outcome of [
			"delivered",
			"queued",
			"stopped",
			"already-finished",
			"not-found",
			"invalid",
			"error",
		] as const) {
			const value = result(
				{
					_type: "agent-steer",
					agentId: "agent-one",
					action: outcome === "stopped" || outcome === "already-finished" ? "stop" : "steer",
					outcome,
				},
				outcome === "stopped" ? "summarize its progress" : "Output  ",
			);
			captures.push(capture(`steer/stop ${outcome} compact`, render(control, value)));
			captures.push(capture(`steer/stop ${outcome} expanded`, render(control, value, true)));
		}
		captures.push(
			capture(
				"force stop",
				render(
					control,
					result(
						{ _type: "agent-steer", agentId: "agent-one", action: "stop", outcome: "stopped" },
						"Partial output saved",
					),
					true,
					false,
					true,
				),
			),
		);
		captures.push(capture("utility partial", render(control, result(undefined), true, true)));
		captures.push(
			capture(
				"utility partial metadata",
				render(
					control,
					result({
						_type: "agent-result",
						agentId: "agent-one",
						status: "running",
						verbose: false,
						hasOutput: true,
					}),
					true,
					true,
				),
			),
		);
		captures.push(capture("utility no metadata", render(control, result(undefined), false)));
		captures.push(
			capture(
				"result last turn",
				render(
					control,
					result({
						_type: "agent-result",
						agentId: "agent-one",
						status: "completed",
						verbose: false,
						hasOutput: true,
						turns: 1,
					}),
					true,
				),
			),
		);
		captures.push(
			capture(
				"info empty filtered",
				render(
					control,
					result(
						{ _type: "agent-info", kind: "models", count: 0, query: "missing" },
						"Available models:\n(none)\n\nOmit model to inherit.",
					),
					true,
				),
			),
		);
		captures.push(
			capture(
				"utility metadata-free error",
				render(control, result(undefined, "transport failed  "), true, false, true),
			),
		);
		for (const tool of [
			control,
			createAgentInfoTool(() => {}),
			createAgentResultTool({} as never, new Map()),
			createAgentSteerTool({} as never),
		]) {
			expect(tool.renderShell).toBe("self");
			const callArgs = { action: "stop", kind: "models", agent_id: "agent-one" };
			const call = tool.renderCall?.(callArgs as never, theme as never, ctx());
			captures.push(capture(`${tool.name} hidden call`, call));
			captures.push(
				capture(
					`${tool.name} restored call`,
					tool.renderCall?.(callArgs as never, theme as never, ctx(true)),
				),
			);
		}
		// The same background component caches the terminal row after its manager record disappears.
		let live: AgentRecord | undefined = record();
		const { createAgentTool } = await import("../src/tools.ts");
		const background = createAgentTool(
			{} as never,
			{ getRecord: () => live } as never,
			new Map(),
			() => {},
		);
		const component = render(
			background as never,
			result({ ...details("background"), agentId: "agent-one" }),
		)!;
		captures.push(capture("same background launched", component));
		live = record("completed");
		captures.push(capture("same background completed", component, 120));
		live = undefined;
		captures.push(capture("same background evicted", component, 120));
		expect(captures.join("\n")).toMatchSnapshot();
	} finally {
		try {
			cleanup?.get(host)?.();
		} finally {
			cleanup?.delete(host);
			__resetAgentRunnersForTests();
			restoreRegistry();
			bench.mockRestore();
			models.mockRestore();
			clock.mockRestore();
			process.chdir(cwd);
			if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = agentDir;
			await fixture.restore();
		}
	}
});

test("captures registered notification summaries and bounded expansion", async () => {
	const fixture = await withUiFixture();
	try {
		let renderer:
			| ((
					message: { details?: NotificationDetails },
					options: { expanded: boolean },
					theme: unknown,
			  ) => { render(width: number): string[] } | undefined)
			| undefined;
		registerNotificationRenderer({
			registerMessageRenderer(name: string, callback: typeof renderer) {
				expect(name).toBe("subagent-notification");
				renderer = callback;
			},
		} as unknown as ExtensionAPI);
		if (!renderer) throw new Error("Missing notification renderer");
		const captures: string[] = [];
		for (const status of statuses) {
			const details: NotificationDetails = {
				id: "agent-one",
				description: "Check",
				status,
				modelName: "test/model-one",
				toolUses: 3,
				turnCount: 5,
				maxTurns: 8,
				contextUsage,
				outputTokens: 550,
				streamingMs: 10_000,
				durationMs: 12_000,
				resultPreview: "Output  \n\nLast line  ",
				resultTruncated: true,
				error: status === "error" ? "provider unavailable" : undefined,
			};
			for (const expanded of [false, true])
				captures.push(
					capture(
						`${status} ${expanded ? "expanded" : "compact"}`,
						renderer({ details }, { expanded }, theme),
						80,
						"component",
					),
				);
			if (status === "completed") {
				const component = renderer({ details }, { expanded: false }, theme)!;
				captures.push(capture("same notification 120", component, 120, "component"));
				details.resultPreview = Array.from({ length: 31 }, (_, i) => `line ${i}  `).join("\n");
				const rows = captureRows(renderer({ details }, { expanded: true }, theme)!, {
					width: 80,
					surface: "component",
				});
				expect(rows).toHaveLength(33);
				captures.push(JSON.stringify({ label: "notification detail cap", rows }));
			}
			if (status === "error") {
				details.error = `provider unavailable: ${"full retained diagnostic ".repeat(6)}`;
				captures.push(
					capture(
						"error full diagnostic",
						renderer({ details }, { expanded: true }, theme),
						80,
						"component",
					),
				);
			}
		}
		expect(renderer({}, { expanded: true }, theme)).toBeUndefined();
		expect(captures.join("\n")).toMatchSnapshot();
	} finally {
		await fixture.restore();
	}
});

test("captures the registered widget and status through same-component transitions", async () => {
	const fixture = await withUiFixture();
	const restoreRegistry = saveRegistry();
	const clock = spyOn(Date, "now").mockReturnValue(NOW);
	const timeouts = new Map<number, () => void>();
	let timerId = 0;
	const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
		const id = ++timerId;
		timeouts.set(id, callback);
		return id;
	}) as never);
	const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
		timeouts.delete(id);
	}) as never);
	let agents = [record()];
	const activity: AgentActivity = {
		activeTools: new Map([["read-one", "read"]]),
		toolUses: 3,
		responseText: "",
		turnCount: 5,
		maxTurns: 8,
		lifetimeUsage: usage,
		streamingMs: 10_000,
		session: agents[0]!.session,
	};
	const widget = new AgentWidget(
		{ listAgents: () => agents } as never,
		new Map([["agent-one", activity]]),
	);
	let component: ReturnType<Exclude<Parameters<UICtx["setWidget"]>[1], undefined>> | undefined;
	let status: string | undefined;
	let registrations = 0;
	let invalidations = 0;
	const tui = {
		terminal: { columns: 80 },
		requestRender() {
			invalidations++;
		},
	};
	try {
		setDefaultsDisabled(false);
		registerAgents(new Map());
		widget.setUICtx({
			theme,
			setStatus(key, text) {
				expect(key).toBe("subagents");
				status = text;
			},
			setWidget(key, factory, options) {
				expect(key).toBe("agents");
				if (factory) {
					expect(options?.placement).toBe("aboveEditor");
					registrations++;
					component = factory(tui, theme);
				} else component = undefined;
			},
		});
		widget.update();
		if (!component) throw new Error("Missing widget component");
		const original = component;
		const captures: string[] = [];
		const view = (label: string) => {
			captures.push(
				JSON.stringify({
					label,
					width: tui.terminal.columns,
					surface: "component",
					rows: captureRows(original, { width: tui.terminal.columns, surface: "component" }),
					status: captureRows(new Text(status ?? "", 0, 0), { width: 80, surface: "component" }),
				}),
			);
		};
		view("running 80");
		tui.terminal.columns = 120;
		view("same running 120");
		agents.push(record("queued"));
		widget.update();
		view("same running queued");
		for (const terminal of statuses) {
			agents = [record(terminal)];
			widget.update();
			view(`same ${terminal}`);
		}
		expect(registrations).toBe(1);
		expect(invalidations).toBe(6);
		agents = [record("queued")];
		widget.update();
		view("same queued only");
		agents = [
			{
				...record(),
				description: "Check every retained contract and every source path before the final report.",
			},
		];
		widget.update();
		view("same long description 120");
		tui.terminal.columns = 80;
		view("same long description 80");
		agents = Array.from({ length: 14 }, (_, i) => ({
			...record(i < 11 ? "running" : "completed"),
			id: `agent-${i}`,
			description: "Check",
		}));
		widget.update();
		view("same overflow");
		expect(original.render()).toHaveLength(12);
		agents = [{ ...record(), isBackground: false }];
		widget.update();
		expect(component).toBeUndefined();
		expect(status).toBeUndefined();
		captures.push(capture("same foreground excluded", original, 80, "component"));
		agents = [{ ...record("completed"), completedAt: NOW - 60_000 }];
		captures.push(capture("same expired", original, 80, "component"));
		agents = [];
		captures.push(capture("same empty", original, 80, "component"));
		expect(captures.join("\n")).toMatchSnapshot();
	} finally {
		try {
			widget.dispose();
			expect(timeouts.size).toBe(0);
		} finally {
			timeout.mockRestore();
			clear.mockRestore();
			clock.mockRestore();
			restoreRegistry();
			await fixture.restore();
		}
	}
});

test("captures registered lifecycle delivery and consumption without a real runner", async () => {
	const fixture = await withUiFixture();
	const restoreRegistry = saveRegistry();
	const cwd = process.cwd();
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const clock = spyOn(Date, "now").mockReturnValue(NOW - 12_000);
	const timeouts = new Map<number, { callback: () => void; delay: number }>();
	const intervals = new Map<number, () => void>();
	let timerId = 0;
	const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		delay: number,
	) => {
		const id = ++timerId;
		timeouts.set(id, { callback, delay });
		return id;
	}) as never);
	const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
		const id = ++timerId;
		intervals.set(id, callback);
		return id;
	}) as never);
	const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
		timeouts.delete(id);
	}) as never);
	const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => {
		intervals.delete(id);
	}) as never);
	const tools = new Map<string, ReturnType<typeof createAgentInfoTool>>();
	const hooks = new Map<string, (event: unknown, ctx: unknown) => void>();
	const notifications: { details: NotificationDetails; content: string }[] = [];
	let widget: { render(): string[]; invalidate(): void } | undefined;
	let status: string | undefined;
	let manager: AgentManager | undefined;
	const originalSpawn = AgentManager.prototype.spawn;
	const spawn = spyOn(AgentManager.prototype, "spawn").mockImplementation(function (
		this: AgentManager,
		...args: Parameters<typeof originalSpawn>
	) {
		manager = this;
		return originalSpawn.apply(this, args);
	});
	const runs: {
		deferred: ReturnType<typeof Promise.withResolvers<RunResult>>;
		options: RunOptions;
	}[] = [];
	const session = {
		getSessionStats: () => ({ tokens: usage, contextUsage }),
		dispose() {},
		steer: async () => {},
	} as never;
	__setRunAgentForTests((_ctx, _type, _prompt, options) => {
		const deferred = Promise.withResolvers<RunResult>();
		runs.push({ deferred, options });
		return deferred.promise;
	});
	const host = {
		registerTool(tool: ReturnType<typeof createAgentInfoTool>) {
			tools.set(tool.name, tool);
		},
		registerMessageRenderer() {},
		on(name: string, callback: (event: unknown, ctx: unknown) => void) {
			hooks.set(name, callback);
		},
		sendMessage(message: { details: NotificationDetails; content: string }, options: unknown) {
			expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
			notifications.push(message);
		},
	};
	const ui: UICtx = {
		theme,
		setStatus(_key, text) {
			status = text;
		},
		setWidget(_key, factory) {
			widget = factory?.({ terminal: { columns: 120 }, requestRender() {} }, theme);
		},
	};
	const model = { provider: "test", id: "model-one", name: "test/model-one" };
	const context = {
		ui,
		model,
		modelRegistry: { getAll: () => [model], getAvailable: () => [model], find: () => model },
	};
	try {
		process.chdir(fixture.agentDir);
		process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
		setDefaultsDisabled(false);
		registerPixSubagent(host as never);
		hooks.get("session_start")?.({}, context);
		const agent = tools.get("agent")!;
		const launched = await agent.execute(
			"capture",
			{ type: "Explore", description: "Check", prompt: "Read the source." } as never,
			new AbortController().signal,
			undefined,
			context as never,
		);
		const first = runs[0]!;
		expect(first.options.model).toBe(model as never);
		first.options.onSessionCreated?.(session);
		first.options.onAssistantUsage?.(usage, 10_000);
		first.options.onTurnEnd?.(5);
		first.options.onToolActivity?.({ type: "start", toolName: "read" });
		clock.mockReturnValue(NOW);
		hooks.get("turn_start")?.({}, context);
		const rows = (
			component: { render(width: number): string[] } | undefined,
			surface: "component" | "host-self" = "component",
		) => {
			if (!component) throw new Error("Missing lifecycle component");
			return captureRows(component, { width: 120, surface });
		};
		const card = agent.renderResult?.(
			launched as never,
			{ expanded: false, isPartial: false },
			theme as never,
			{ state: {}, expanded: false, invalidate() {} } as never,
		);
		const captures = [
			JSON.stringify({
				label: "registered running",
				card: rows(card, "host-self"),
				widget: rows(widget),
				status: rows(new Text(status ?? "", 0, 0)),
			}),
		];
		const firstRecord = manager!.getRecord(first.options.agentId!)!;
		first.deferred.resolve({
			session,
			responseText: "Output  \n\nLast line  ",
			aborted: false,
			steered: false,
		});
		await firstRecord.promise;
		// Run the observed 200ms delivery hold. Do not run the widget expiry callback.
		const notificationTimer = [...timeouts.entries()].find(([, timer]) => timer.delay === 200);
		if (!notificationTimer) throw new Error("Missing notification hold timer");
		timeouts.delete(notificationTimer[0]);
		notificationTimer[1].callback();
		expect(notifications).toHaveLength(1);
		expect(notifications[0]!.details.resultPreview).toBe("Output  \n\nLast line  ");
		captures.push(
			JSON.stringify({
				label: "registered completed delivery",
				card: rows(card, "host-self"),
				widget: rows(widget),
				details: { ...notifications[0]!.details, id: "agent-one" },
			}),
		);
		await agent.execute(
			"consumed",
			{ type: "Explore", description: "Check consumed", prompt: "Read the source." } as never,
			new AbortController().signal,
			undefined,
			context as never,
		);
		const second = runs[1]!;
		const secondRecord = manager!.getRecord(second.options.agentId!)!;
		await tools
			.get("agent_control")!
			.execute(
				"consume",
				{ action: "result", agent_id: secondRecord.id } as never,
				new AbortController().signal,
				undefined,
				context as never,
			);
		expect(secondRecord.resultConsumed).toBe(true);
		second.deferred.resolve({
			session,
			responseText: "Consumed output",
			aborted: false,
			steered: false,
		});
		await secondRecord.promise;
		expect(notifications).toHaveLength(1);
		captures.push(
			JSON.stringify({
				label: "registered consumed",
				consumed: secondRecord.resultConsumed,
				deliveries: notifications.length,
			}),
		);
		hooks.get("session_shutdown")?.({}, context);
		expect(widget).toBeUndefined();
		expect(status).toBeUndefined();
		expect(timeouts.size).toBe(0);
		expect(intervals.size).toBe(0);
		captures.push(
			JSON.stringify({
				label: "registered shutdown",
				widget: [],
				status: [],
				timeouts: timeouts.size,
				intervals: intervals.size,
			}),
		);
		expect(captures.join("\n")).toMatchSnapshot();
	} finally {
		// Settle every fake before shutdown, including failures in assertions or registration.
		try {
			const pending = manager?.listAgents().map((agent) => agent.promise) ?? [];
			for (const run of runs)
				run.deferred.resolve({ session, responseText: "cleanup", aborted: false, steered: false });
			await Promise.allSettled(pending);
			hooks.get("session_shutdown")?.({}, context);
		} finally {
			__resetAgentRunnersForTests();
			spawn.mockRestore();
			timeout.mockRestore();
			interval.mockRestore();
			clearTimeoutSpy.mockRestore();
			clearIntervalSpy.mockRestore();
			clock.mockRestore();
			restoreRegistry();
			process.chdir(cwd);
			if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = agentDir;
			await fixture.restore();
		}
	}
});
