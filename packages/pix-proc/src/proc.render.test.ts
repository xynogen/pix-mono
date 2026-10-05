import { expect, spyOn, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { agentDir } from "@xynogen/pix-runtime/paths";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import type { ProcMeta } from "./format.ts";

test("proc registered self shell, modal, and widget with a fake manager", async () => {
	if (!agentDir().includes("pix-test-home-")) throw new Error("Test sandbox preload required");
	const cache = process.env.XDG_CACHE_HOME;
	const fixture = await withUiFixture();
	const restores: { mockRestore(): void }[] = [];
	let shutdown: (() => Promise<void>) | undefined;
	try {
		process.env.XDG_CACHE_HOME = `${fixture.agentDir}/capture-cache`;
		const { ProcManager } = await import("./manager.ts");
		const { default: register } = await import("./index.ts");
		let now = 10_000;
		restores.push(spyOn(Date, "now").mockImplementation(() => now));
		const timers = new Map<number, () => void>();
		let timerId = 0;
		restores.push(
			spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
				timers.set(++timerId, callback);
				return timerId;
			}) as never),
		);
		restores.push(
			spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => {
				timers.delete(id);
			}) as never),
		);
		let procs: ProcMeta[] = [
			{
				handle: "proc-dev",
				command: "serve",
				cwd: "/fixture",
				pid: 42,
				pgid: 42,
				startTime: 5_000,
				status: "running",
				capped: true,
			},
			{
				handle: "proc-old",
				command: "compile",
				cwd: "/fixture",
				pid: 43,
				pgid: 43,
				startTime: 0,
				status: "exited",
				exitCode: 1,
				capped: false,
			},
		];
		let log: Promise<string[]> = Promise.resolve(["ready on :5173"]);
		restores.push(spyOn(ProcManager.prototype, "list").mockImplementation(() => procs));
		restores.push(
			spyOn(ProcManager.prototype, "findOrphans").mockImplementation(async () => [
				{ handle: "proc-dev", pgid: 42, command: "serve" },
			]),
		);
		restores.push(spyOn(ProcManager.prototype, "adoptOrphan").mockImplementation(() => procs[0]!));
		restores.push(spyOn(ProcManager.prototype, "checkCap").mockImplementation(() => {}));
		restores.push(
			spyOn(ProcManager.prototype, "logsTail").mockImplementation(async () => ({
				lines: await log,
				logPath: "/fixture/log",
				capped: false,
			})),
		);
		restores.push(spyOn(ProcManager.prototype, "shutdown").mockImplementation(async () => {}));
		restores.push(
			spyOn(ProcManager.prototype, "start").mockImplementation(() => {
				throw new Error("Real process start forbidden");
			}),
		);
		restores.push(
			spyOn(ProcManager.prototype, "stop").mockImplementation(async () => {
				throw new Error("Real process stop forbidden");
			}),
		);
		restores.push(
			spyOn(ProcManager.prototype, "rm").mockImplementation(() => {
				throw new Error("Real process removal forbidden");
			}),
		);
		restores.push(
			spyOn(ProcManager.prototype, "killOrphan").mockImplementation(() => {
				throw new Error("Real orphan kill forbidden");
			}),
		);
		type Component = { render(width: number): string[] };
		type Modal = Component & { handleInput(data: string): void; loading: Promise<void> };
		let tool:
			| {
					renderShell: string;
					renderCall(args: unknown, theme: Theme, context: unknown): Component;
					renderResult(
						result: unknown,
						options: unknown,
						theme: Theme,
						context: unknown,
					): Component;
			  }
			| undefined;
		let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		register({
			on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
				events.set(name, handler);
			},
			registerTool(value: typeof tool) {
				tool = value;
			},
			registerCommand(_name: string, value: { handler: typeof command }) {
				command = value.handler;
			},
		} as never);
		if (!tool || !command) throw new Error("proc registration unavailable");
		expect(tool.renderShell).toBe("self");
		const theme = roleTheme() as unknown as Theme;
		const tui = { terminal: { rows: 16, cols: 80 }, requestRender() {} } as unknown as TUI;
		const kb = new KeybindingsManager(TUI_KEYBINDINGS);
		const states: string[] = [];
		const capture = (
			name: string,
			component: Component,
			surface: "component" | "host-self" = "component",
		) => states.push(name, ...captureRows(component, { width: 80, surface }));
		capture(
			"wrapped call",
			tool.renderCall(
				{
					action: "start",
					command:
						"serve --port 5173 --host localhost --config fixture/config.ts --watch fixture/source",
				},
				theme,
				{ expanded: false, state: {}, invalidate() {} },
			),
			"host-self",
		);
		for (const [name, expanded, partial, failed, details] of [
			["partial", false, true, false, false],
			["compact success", false, false, false, true],
			["expanded", true, false, false, true],
			["compact error", false, false, true, true],
			["expanded error", true, false, true, true],
			["fallback", false, false, false, false],
		] as const)
			capture(
				name,
				tool.renderResult(
					{
						content: [{ type: "text", text: "ready\nlistening" }],
						details: details
							? {
									_type: "procResult",
									action: "start",
									ok: !failed,
									lines: ["proc-dev started", "ready"],
									error: failed ? "start requires a command" : undefined,
								}
							: undefined,
					},
					{ expanded, isPartial: partial },
					theme,
					{ expanded, isError: failed },
				),
				"host-self",
			);
		let widget: Component | undefined;
		const ui = {
			select: async () => "Keep all",
			setWidget(_key: string, factory?: (_tui: TUI, theme: Theme) => Component) {
				widget = factory?.(tui, theme);
			},
			notify() {
				throw new Error("Unexpected process action");
			},
			custom: async (
				factory: (
					tui: TUI,
					theme: Theme,
					kb: KeybindingsManager,
					done: (value: undefined) => void,
				) => Modal,
			) => {
				const modal = factory(tui, theme, kb, () => {});
				capture("list", modal);
				const pending = Promise.withResolvers<string[]>();
				log = pending.promise;
				modal.handleInput("\r");
				try {
					capture("loading", modal);
				} finally {
					pending.resolve(["ready on :5173"]);
					await modal.loading;
				}
				capture("running detail", modal);
				procs = [{ ...procs[0]!, status: "exited", exitCode: 0 }];
				log = Promise.resolve(Array.from({ length: 30 }, (_, i) => `log ${i + 1}`));
				for (const callback of timers.values()) callback();
				await modal.loading;
				modal.render(80);
				modal.handleInput("\x1b[6~");
				capture("finished paged detail", modal);
				modal.handleInput("\x1b");
				modal.handleInput("\r");
				procs = [{ ...procs[0]!, status: "running" }];
				log = Promise.reject(new Error("fixture read"));
				for (const callback of timers.values()) callback();
				await modal.loading;
				capture("failed read", modal);
				log = Promise.resolve([]);
				for (const callback of timers.values()) callback();
				await modal.loading;
				capture("empty log", modal);
				procs = [];
				for (const callback of timers.values()) callback();
				capture("empty list", modal);
				return undefined;
			},
		};
		shutdown = () => events.get("session_shutdown")!({}, { ui });
		await events.get("session_start")!({}, { ui });
		if (!widget) throw new Error("Widget not registered");
		capture("running capped and recent widget", widget);
		await command("", { ui });
		await fixture.runtime.update(collapseSection, (current) => ({ ...current, delaySec: 1 }));
		now += 2_000;
		for (const callback of timers.values()) callback();
		expect(widget).toBeUndefined();
		states.push(
			"cleared widget",
			...captureRows({ render: () => [] }, { width: 80, surface: "component" }),
		);
		await shutdown();
		expect(timers.size).toBe(0);
		expect(states.join("\n")).toMatchSnapshot();
	} finally {
		try {
			await shutdown?.();
		} finally {
			for (const restore of restores.reverse()) restore.mockRestore();
			if (cache === undefined) delete process.env.XDG_CACHE_HOME;
			else process.env.XDG_CACHE_HOME = cache;
			await fixture.restore();
		}
	}
});
