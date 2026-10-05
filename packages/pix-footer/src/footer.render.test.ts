import { expect, spyOn, test } from "bun:test";
import { benchlm, modelgrep } from "@xynogen/pix-data";
import * as os from "@xynogen/pix-runtime/os";
import { prettySection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import registerFooter from "./footer.ts";

test("actual footer factory flags, stream decay and subscriptions without Git", async () => {
	const fixture = await withUiFixture();
	let now = 10_000;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const timers = new Map<number, { callback: () => void; delay: number; interval: boolean }>();
	let nextTimer = 0;
	const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		delay: number,
	) => {
		timers.set(++nextTimer, { callback, delay, interval: false });
		return nextTimer;
	}) as never);
	const interval = spyOn(globalThis, "setInterval").mockImplementation(((
		callback: () => void,
		delay: number,
	) => {
		timers.set(++nextTimer, { callback, delay, interval: true });
		return nextTimer;
	}) as never);
	const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) =>
		timers.delete(id)) as never);
	const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(((id: number) =>
		timers.delete(id)) as never);
	const gitJobs: Promise<string>[] = [];
	const git = spyOn(os, "runGit").mockImplementation(() => {
		const job = Promise.resolve(
			"## main...origin/main [ahead 2, behind 1]\nM  staged\n M changed\n?? new\n",
		);
		gitJobs.push(job);
		return job;
	});
	const models = spyOn(modelgrep, "getCached").mockReturnValue([
		{ id: "fixture/capture", benchmarks: { artificial_analysis: { coding: 70 } } },
	]);
	const benchmarks = spyOn(benchlm, "getCached").mockReturnValue([]);
	const hooks = new Map<string, (event: unknown, ctx?: unknown) => Promise<void> | void>();
	let component: { render(width: number): string[]; dispose(): void } | undefined;
	let branch = "main";
	let branchChanged: (() => void) | undefined;
	let branchDisposed = 0;
	let paints = 0;
	const ctx = {
		cwd: "/fixture/project",
		model: {
			id: "capture",
			provider: "fixture",
			contextWindow: 100_000,
			cost: { input: 3, output: 15 },
		},
		getContextUsage: () => ({ percent: 85, contextWindow: 100_000 }),
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: { input: 1200, output: 200, cacheRead: 300, cost: { total: 0.123 } },
					},
				},
			],
		},
		ui: {
			setFooter: (factory: (tui: unknown, theme: unknown, data: unknown) => typeof component) => {
				component = factory({ requestRender: () => paints++ }, roleTheme(), {
					getGitBranch: () => branch,
					getExtensionStatuses: () =>
						new Map([
							["plan", "PLAN"],
							["mcp", "2/3 servers"],
							["pi-lens-lsp", "LSP Active: ts, json · LSP Failed: eslint"],
						]),
					onBranchChange: (callback: () => void) => {
						branchChanged = callback;
						return () => {
							branchChanged = undefined;
							branchDisposed++;
						};
					},
				});
			},
		},
	};
	const states: Record<string, string[]> = {};
	try {
		registerFooter({
			on: (name: string, hook: never) => hooks.set(name, hook),
			getThinkingLevel: () => "high",
		} as never);
		await hooks.get("session_start")?.({}, ctx);
		await hooks.get("tool_execution_end")?.({}, ctx);
		if (!component) throw new Error("Footer factory did not create a component");
		const footer = component;
		const take = (name: string, width = 80) => {
			states[name] = captureRows(footer, { width, surface: "component" });
		};
		const defaults = prettySection.defaults.footer;
		const flags = Object.keys(defaults) as (keyof typeof defaults)[];
		expect(flags).toHaveLength(12);
		take("idle / 80");
		take("idle / 120", 120);
		await hooks.get("message_start")?.({ message: { role: "assistant", id: "stream" } });
		now += 2000;
		await hooks.get("message_update")?.({
			message: { role: "assistant", id: "stream", usage: { output: 200 } },
			assistantMessageEvent: { type: "text_delta" },
		});
		const tick = [...timers.values()].find((timer) => timer.delay === 100);
		expect(tick?.interval).toBe(true);
		tick?.callback();
		take("stream / 120", 120);
		const activityFlags = Object.fromEntries(
			flags.map((key) => [key, ["tokens", "cost", "tps"].includes(key)]),
		) as typeof defaults;
		await fixture.runtime.update(prettySection, { footer: activityFlags });
		take("activity / 80");
		for (const key of flags) {
			const footerFlags = Object.fromEntries(
				flags.map((flag) => [flag, flag === key]),
			) as typeof defaults;
			const beforePaint = paints;
			await fixture.runtime.update(prettySection, { footer: footerFlags });
			expect(paints).toBeGreaterThan(beforePaint);
			take(`only ${key} / 80`);
		}
		await fixture.runtime.update(prettySection, { footer: activityFlags });
		await hooks.get("message_end")?.({
			message: { role: "assistant", id: "stream", usage: { output: 200 } },
		});
		await hooks.get("agent_end")?.({});
		const pending = [...timers.entries()].filter(
			([, timer]) => !timer.interval && timer.delay === 4000,
		);
		expect(pending).toHaveLength(2);
		for (const [id, timer] of pending) {
			timers.delete(id);
			timer.callback();
		}
		take("faded activity / 80");
		for (const [id, timer] of [...timers])
			if (!timer.interval) {
				timers.delete(id);
				timer.callback();
			}
		take("expired activity / 80");
		expect(states["expired activity / 80"]).toEqual([]);
		await fixture.runtime.update(prettySection, { footer: defaults });
		branch = "feature";
		branchChanged?.();
		await hooks.get("tool_execution_end")?.({}, ctx);
		take("branch repaint / 80");
		await fixture.runtime.update(prettySection, {
			footer: Object.fromEntries(flags.map((key) => [key, false])) as typeof defaults,
		});
		take("all disabled / 80");
		expect(states["all disabled / 80"]).toEqual([]);
		expect(paints).toBeGreaterThan(12);
		footer.dispose();
		component = undefined;
		const disposedPaints = paints;
		await fixture.runtime.update(prettySection, { footer: defaults });
		expect(paints).toBe(disposedPaints);
		expect(branchDisposed).toBe(1);
		expect(states).toMatchSnapshot();
	} finally {
		try {
			component?.dispose();
			await hooks.get("session_shutdown")?.({});
			await Promise.all(gitJobs);
		} finally {
			clock.mockRestore();
			timeout.mockRestore();
			interval.mockRestore();
			clearTimeoutSpy.mockRestore();
			clearIntervalSpy.mockRestore();
			git.mockRestore();
			models.mockRestore();
			benchmarks.mockRestore();
			await fixture.restore();
		}
	}
	expect(timers.size).toBe(0);
});
