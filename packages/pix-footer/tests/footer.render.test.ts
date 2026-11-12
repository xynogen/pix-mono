import { expect, spyOn, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type Color, colorToHex, rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import { benchlm, modelgrep } from "@xynogen/pix-data";
import * as os from "@xynogen/pix-runtime/os";
import { prettySection } from "@xynogen/pix-runtime/sections";
import * as sysstat from "@xynogen/pix-runtime/sysstat";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import registerFooter from "../src/footer.ts";

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
	// Host load varies, so pin it; the 10s clock renders as 00:00 under the pinned TZ.
	const stats = spyOn(sysstat, "readSystemStats").mockResolvedValue({
		cpu: 12,
		cpuTemp: 56,
		gpu: 95,
		gpuTemp: 68,
		ram: 58,
	});
	const tz = process.env.TZ;
	process.env.TZ = "UTC";
	const hooks = new Map<string, (event: unknown, ctx?: unknown) => Promise<void> | void>();
	let component: { render(width: number): string[]; dispose(): void } | undefined;
	let branch = "main";
	let branchChanged: (() => void) | undefined;
	let branchDisposed = 0;
	let paints = 0;
	const fadeColors: Color[] = [];
	const roles = roleTheme();
	const theme = {
		...roles,
		colors: { dim: rgbColor(180, 180, 180), customMessageBg: rgbColor(20, 20, 20) },
		style: (text: string, style: { fg: Color }) => {
			fadeColors.push(style.fg);
			return roles.fg("muted", text);
		},
	};
	const statuses = new Map([
		["plan", "PLAN"],
		["mcp", "2/3 servers"],
		["pi-lens-lsp", "LSP Active: ts, json · LSP Failed: eslint"],
	]);
	let historyReads = 0;
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
			getBranch: () => {
				historyReads++;
				return [
					{
						type: "message",
						message: {
							role: "assistant",
							usage: { input: 1200, output: 200, cacheRead: 300, cost: { total: 0.123 } },
						},
					},
				];
			},
		},
		ui: {
			setFooter: (factory: (tui: unknown, theme: unknown, data: unknown) => typeof component) => {
				component = factory({ requestRender: () => paints++ }, theme, {
					getGitBranch: () => branch,
					getExtensionStatuses: () => statuses,
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
		const systemTick = [...timers.values()].find((timer) => timer.delay === 2000);
		expect(stats).toHaveBeenCalledTimes(1);
		systemTick?.callback();
		expect(stats).toHaveBeenCalledTimes(1);
		now += 6000;
		systemTick?.callback();
		await Promise.resolve();
		expect(stats).toHaveBeenCalledTimes(2);
		if (!component) throw new Error("Footer factory did not create a component");
		const footer = component;
		const initialHistoryReads = historyReads;
		for (let i = 0; i < 100; i++) footer.render(400);
		expect(historyReads).toBe(initialHistoryReads);
		const take = (name: string, width = 80) => {
			states[name] = captureRows(footer, { width, surface: "component" });
		};
		const defaults = prettySection.defaults.footer;
		const flags = Object.keys(defaults) as (keyof typeof defaults)[];
		expect(flags).toHaveLength(14);
		take("idle / 80");
		take("idle / 120", 120);
		const wide = footer.render(240);
		expect(wide).toHaveLength(1);
		expect(stripVTControlCharacters(wide[0] ?? "")).toMatch(
			/PLAN.*capture.*\[85\.0K[/]100\.0K · 85%\].*2[/]3.*2 !1/,
		);
		expect(stripVTControlCharacters(wide[0] ?? "")).toMatch(/⚡74 {3,}/);
		// Keep the original left/right split and evenly spaced thin section bars.
		expect(visibleWidth(wide[0] ?? "")).toBe(240);
		expect(stripVTControlCharacters(wide[0] ?? "")).toMatch(
			/^ PLAN │ .*capture.* {3,}.*2[/]3.*00:00 $/,
		);
		expect(visibleWidth(footer.render(400)[0] ?? "")).toBe(400);
		const stable = stripVTControlCharacters(footer.render(400)[0] ?? "");
		expect(stable).toMatch(/00:00 $/);
		statuses.set("mcp", "12/12 servers");
		statuses.set("fixture", "background task running");
		const busy = stripVTControlCharacters(footer.render(400)[0] ?? "");
		for (const marker of ["capture", "12%", "00:00"]) {
			expect(busy.indexOf(marker)).toBe(stable.indexOf(marker));
		}
		expect(busy).toMatch(/capture.* {3,}.*12[/]12.* │ .*background task running.*12%.*00:00 $/);
		statuses.set("mcp", "2/3 servers");
		statuses.delete("fixture");
		expect(defaults.wrap).toBe(false);
		expect(footer.render(40)).toHaveLength(1);
		const clipped = footer.render(40)[0]!;
		expect(visibleWidth(clipped)).toBe(40);
		expect(stripVTControlCharacters(clipped)).toStartWith(" PLAN");
		expect(fadeColors.length).toBeGreaterThan(1);
		expect(colorToHex(fadeColors.at(-1)!)).toBe("#141414");
		const unique = new Set(fadeColors.map(colorToHex));
		expect(unique.size).toBeGreaterThan(2);
		for (let width = 0; width <= 100; width++) {
			const rows = footer.render(width);
			expect(rows.length).toBeLessThanOrEqual(1);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
		await fixture.runtime.update(prettySection, { footer: { wrap: true } });
		expect(footer.render(240)).toHaveLength(1);
		const joined = stripVTControlCharacters(wide[0] ?? "").replace(/ {3,}/, " │ ");
		for (const width of [16, 40, 80, 120]) {
			const rows = footer.render(width);
			if (visibleWidth(joined) > width) expect(rows.length).toBeGreaterThan(1);
			else expect(rows).toHaveLength(1);
			expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
			const flat = rows.map((row) => stripVTControlCharacters(row).trim()).join(" ");
			expect(flat.replace(/\s+/g, " ").trim()).toBe(joined.replace(/\s+/g, " ").trim());
		}
		await fixture.runtime.update(prettySection, { footer: { statuses: false } });
		expect(stripVTControlCharacters(footer.render(240)[0] ?? "")).toMatch(/PLAN.*capture/);
		expect(stripVTControlCharacters(footer.render(240)[0] ?? "")).not.toContain("2/3");
		await fixture.runtime.update(prettySection, { footer: defaults });
		await hooks.get("message_start")?.({ message: { role: "assistant", id: "stream" } });
		const started = footer.render(400)[0] ?? "";
		expect(started).toContain(theme.fg("dim", "— t/s"));
		expect(stripVTControlCharacters(started)).toMatch(/— t[/]s · .*1\.2K.*200/);
		for (const mode of ["AFK", "YOLO", "NUCLEAR"]) {
			statuses.set("unattended", mode);
			const row = stripVTControlCharacters(footer.render(400)[0] ?? "");
			expect(row).toMatch(new RegExp(`\\$~?0\\.123.* │ ${mode} │ .*2[/]3`));
			expect(row.match(new RegExp(mode, "g"))).toHaveLength(1);
		}
		await fixture.runtime.update(prettySection, { footer: { statuses: false } });
		expect(stripVTControlCharacters(footer.render(400)[0] ?? "")).not.toContain("NUCLEAR");
		await fixture.runtime.update(prettySection, { footer: defaults });
		statuses.delete("unattended");
		now += 2000;
		await hooks.get("message_update")?.({
			message: { role: "assistant", id: "stream", usage: { output: 200 } },
			assistantMessageEvent: { type: "text_delta" },
		});
		const tick = [...timers.values()].find((timer) => timer.delay === 100);
		expect(tick?.interval).toBe(true);
		tick?.callback();
		take("stream / 120", 120);
		const streaming = stripVTControlCharacters(footer.render(400)[0] ?? "");
		for (const marker of ["capture", "12%", "00:00"]) {
			expect(streaming.indexOf(marker)).toBe(stable.indexOf(marker));
		}
		expect(streaming).toMatch(
			/capture.* {3,}100 t[/]s · .*1\.2K.*200.* │ .*2[/]3.* │ .*12%.*00:00 $/,
		);
		expect(footer.render(400)[0]).toContain(theme.fg("dim", "100 t/s"));
		expect(streaming.match(/1\.2K/g)).toHaveLength(1);
		if (process.env.PIX_PROFILE_FOOTER === "1") {
			for (const width of [80, 120, 240, 400]) {
				for (let i = 0; i < 200; i++) footer.render(width);
				const samples: number[] = [];
				const readsBefore = historyReads;
				for (let i = 0; i < 2000; i++) {
					const start = performance.now();
					footer.render(width);
					samples.push(performance.now() - start);
				}
				samples.sort((a, b) => a - b);
				console.log(
					JSON.stringify({
						width,
						iterations: samples.length,
						meanMs: samples.reduce((sum, n) => sum + n, 0) / samples.length,
						p50Ms: samples[1000],
						p95Ms: samples[1900],
						p99Ms: samples[1980],
						historyReads: historyReads - readsBefore,
					}),
				);
			}
		}
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
			if (key === "statuses") expect(footer.render(80)).toHaveLength(1);
		}
		await fixture.runtime.update(prettySection, { footer: activityFlags });
		await hooks.get("message_end")?.({
			message: { role: "assistant", id: "stream", usage: { output: 200 } },
		});
		await hooks.get("agent_end")?.({});
		const pending = [...timers.entries()].filter(
			([, timer]) => !timer.interval && timer.delay === 4000,
		);
		expect(pending).toHaveLength(1);
		for (const [id, timer] of pending) {
			timers.delete(id);
			timer.callback();
		}
		take("faded activity / 80");
		const faded = footer.render(80)[0] ?? "";
		expect(faded).toContain(theme.fg("muted", "100 t/s"));
		expect(stripVTControlCharacters(faded)).toMatch(/100 t[/]s · .*1\.2K.*200/);
		expect(faded).toContain(theme.fg("dim", "$~0.123"));
		for (const [id, timer] of [...timers])
			if (!timer.interval) {
				timers.delete(id);
				timer.callback();
			}
		take("expired activity / 80");
		expect(stripVTControlCharacters(footer.render(80)[0] ?? "").trim()).toBe("$~0.123");
		expect(footer.render(80)[0]).toContain(theme.fg("dim", "$~0.123"));
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
		await fixture.runtime.update(prettySection, { footer: activityFlags });
		await hooks.get("message_end")?.({
			message: {
				role: "assistant",
				id: "next",
				usage: { input: 100, output: 20, cacheRead: 0, cost: { total: 0.1 } },
			},
		});
		expect(stripVTControlCharacters(footer.render(400)[0] ?? "")).toContain("$~0.223");
		expect(historyReads).toBe(initialHistoryReads);
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
			stats.mockRestore();
			if (tz === undefined) delete process.env.TZ;
			else process.env.TZ = tz;
			await fixture.restore();
		}
	}
	expect(timers.size).toBe(0);
});
