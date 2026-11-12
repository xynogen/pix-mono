/**
 * widget-uictx.test.ts — regression for the "running background agent's row
 * vanishes after the launching turn ends" bug.
 *
 * Root cause was capturing ctx.ui only at turn_start: a background agent
 * outlives its launching turn, so once that turn ended the widget wrote to a
 * stale UI ctx and stopped painting though the agent kept running. Fix: capture
 * the session-stable ctx (session_start) once, and never swap it per-turn.
 *
 * These tests pin the two behaviours that make that fix hold:
 *   1. setUICtx is idempotent for the same reference (no needless re-register).
 *   2. While a background agent is running, update() keeps the widget
 *      registered on the ctx it was given — it never clears it.
 */

import { expect, test } from "bun:test";
import {
	rgbColor,
	stripTerminalSequences,
	styleText,
	type TextStyle,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { AgentWidget, lingerWindows, type UICtx } from "../src/ui/widget.ts";

type Theme = UICtx["theme"];

type SetWidgetContent = Parameters<UICtx["setWidget"]>[1];

// Minimal spy UI ctx: records the last setWidget/setStatus calls.
function makeSpyCtx(): UICtx & {
	widgetContent: SetWidgetContent;
	statusText: string | undefined;
	setWidgetCalls: number;
} {
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;
	const ctx = {
		theme,
		widgetContent: undefined as SetWidgetContent,
		statusText: undefined as string | undefined,
		setWidgetCalls: 0,
		setStatus(_key: string, text: string | undefined) {
			ctx.statusText = text;
		},
		setWidget(_key: string, content: SetWidgetContent) {
			ctx.setWidgetCalls++;
			ctx.widgetContent = content;
		},
	};
	return ctx;
}

// Duck-typed manager exposing only what AgentWidget reads.
function makeManager(agents: Array<Record<string, unknown>>) {
	return { listAgents: () => agents } as unknown as ConstructorParameters<typeof AgentWidget>[0];
}

const runningBg = {
	id: "a1",
	type: "general",
	status: "running",
	isBackground: true,
	description: "long job",
	toolUses: 0,
	startedAt: Date.now(),
	compactionCount: 0,
};

test("setUICtx is idempotent for the same reference", () => {
	const widget = new AgentWidget(makeManager([runningBg]), new Map());
	const ctx = makeSpyCtx();
	widget.setUICtx(ctx);
	widget.update();
	const callsAfterFirst = ctx.setWidgetCalls;
	// Re-supplying the SAME ctx (e.g. an extra event) must not re-register.
	widget.setUICtx(ctx);
	widget.update();
	expect(ctx.setWidgetCalls).toBe(callsAfterFirst); // no churn
	widget.dispose();
});

test("a running background agent keeps its widget registered across updates", () => {
	const widget = new AgentWidget(makeManager([runningBg]), new Map());
	const ctx = makeSpyCtx();
	widget.setUICtx(ctx);
	widget.update();
	expect(ctx.widgetContent).toBeDefined(); // widget shown
	expect(ctx.statusText).toBeDefined(); // status chip shown

	// Simulate turn boundaries firing repeatedly while the agent keeps running:
	// the widget must NOT clear itself (the vanish bug).
	for (let i = 0; i < 5; i++) widget.update();
	expect(ctx.widgetContent).toBeDefined();
	expect(ctx.statusText).toBeDefined();
	widget.dispose();
});

test("widget has one row per agent and caps overflow under a full-width rule", () => {
	const agents = Array.from({ length: 20 }, (_, i) => ({ ...runningBg, id: `a${i}` }));
	const widget = new AgentWidget(makeManager(agents), new Map());
	const ctx = makeSpyCtx();
	widget.setUICtx(ctx);
	widget.update();
	if (typeof ctx.widgetContent !== "function") throw new Error("agent widget was not registered");
	const component = ctx.widgetContent({ terminal: { columns: 160 } }, ctx.theme);
	const lines = component.render();
	expect(lines[0]).toBe("─".repeat(160));
	expect(lines[1]).toMatch(/^\S+\s+Agent +│.*long job/);
	expect(lines[2]).toMatch(/^ +│.*long job/);
	expect(lines.join("\n").match(/\bAgent\b/g)).toHaveLength(1);
	expect(lines).toHaveLength(12);
	expect(lines.at(-1)).toMatch(/^ {2}\+10 more$/);
	widget.dispose();
});

test("long agent descriptions fade after fixed model, stats and status columns", () => {
	const agents = [
		{
			...runningBg,
			startedAt: Date.now() - 2_000,
			description: "界e\u0301🙂 job ".repeat(60),
			invocation: { modelName: "GPT" },
		},
	];
	const widget = new AgentWidget(makeManager(agents), new Map());
	const ctx = makeSpyCtx();
	ctx.theme = {
		...ctx.theme,
		colors: { dim: rgbColor(180, 180, 180), customMessageBg: rgbColor(20, 20, 20) },
		style: (text: string, style: TextStyle) => styleText(text, style, "truecolor"),
	};
	try {
		widget.setUICtx(ctx);
		widget.update();
		if (typeof ctx.widgetContent !== "function") throw new Error("agent widget missing");
		const tui = { terminal: { columns: 80 } };
		const component = ctx.widgetContent(tui, ctx.theme);
		for (const width of [60, 80, 120]) {
			tui.terminal.columns = width;
			const rows = component.render();
			expect(rows).toHaveLength(2);
			expect(stripTerminalSequences(rows[1]!)).toMatch(
				/^\S+\s+Agent +│ \S+\s+\[GPT\] \(fork\) · 界.* {2,}\d+(?:\.\d+)?s$/,
			);
			expect(rows[1]).toContain("\x1b[38;2;20;20;20m");
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
		for (let width = 0; width < 60; width++) {
			tui.terminal.columns = width;
			for (const row of component.render()) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
		Object.assign(agents[0]!, {
			status: "error",
			completedAt: Date.now(),
			error: "Provider unavailable ".repeat(30),
		});
		tui.terminal.columns = 80;
		const failed = component.render()[1]!;
		expect(stripTerminalSequences(failed)).toMatch(
			/\[GPT\] \(fork\) error · Provider unavailable.* {2,}\d+(?:\.\d+)?s$/,
		);
		expect(failed).toContain("\x1b[38;2;20;20;20m");
	} finally {
		widget.dispose();
	}
});

test("a second agent adds only one row; live activity replaces the description", () => {
	const agents = [{ ...runningBg }, { ...runningBg, id: "a2" }];
	const widget = new AgentWidget(
		makeManager(agents),
		new Map([
			[
				"a1",
				{
					activeTools: new Map([["read", "read"]]),
					responseText: "",
					toolUses: 0,
					turnCount: 0,
					lifetimeUsage: { output: 0 },
				} as never,
			],
		]),
	);
	const ctx = makeSpyCtx();
	try {
		widget.setUICtx(ctx);
		widget.update();
		if (typeof ctx.widgetContent !== "function") throw new Error("widget missing");
		const component = ctx.widgetContent({ terminal: { columns: 120 } }, ctx.theme);
		const rows = component.render();
		expect(rows).toHaveLength(3);
		expect(rows[1]).toMatch(/^\S+\s+Agent +│ \S+\s+\(fork\) · reading.*\d.*s$/);
		expect(rows[2]).toMatch(/^ +│ \S+\s+\(fork\) · long job.*\d.*s$/);
		expect(visibleWidth(rows[1]!.split("│")[0]!)).toBe(visibleWidth(rows[2]!.split("│")[0]!));
		expect(rows.join("\n").match(/\bAgent\b/g)).toHaveLength(1);
		agents.pop();
		expect(component.render()).toHaveLength(2);
	} finally {
		widget.dispose();
	}
});

test("linger windows scale off the shared collapse delay (config-driven)", () => {
	// One knob (config collapse.delaySec) tunes both tool-card collapse and the
	// widget: ok = base, error = base×3. A non-positive base falls back so a
	// misconfigured 0 never collapses the linger to nothing.
	expect(lingerWindows(30_000)).toEqual({ ok: 30_000, error: 90_000 });
	expect(lingerWindows(4_000)).toEqual({ ok: 4_000, error: 12_000 });
	expect(lingerWindows(0)).toEqual({ ok: 10_000, error: 30_000 });
});

test("a steered agent renders as a plain completed row (no turn-limit tag)", () => {
	// steered = wrapped up at the soft turn limit but finished fine == completed.
	const steered = { ...runningBg, status: "steered", completedAt: Date.now() };
	const widget = new AgentWidget(makeManager([steered]), new Map());
	const ctx = makeSpyCtx();
	widget.setUICtx(ctx);
	widget.update();
	if (typeof ctx.widgetContent !== "function") throw new Error("steered finished row not shown");
	const rendered = ctx
		.widgetContent({ terminal: { columns: 160 } }, ctx.theme)
		.render()
		.join("\n");
	expect(rendered).toContain("long job");
	expect(rendered).not.toContain("turn limit");
	widget.dispose();
});

test("widget clears only once no agent is active", () => {
	const done = { ...runningBg, status: "completed", completedAt: Date.now() - 60_000 };
	const widget = new AgentWidget(makeManager([done]), new Map());
	const ctx = makeSpyCtx();
	widget.setUICtx(ctx);
	widget.update();
	// linger long expired (60s ago) → nothing active → widget + status cleared.
	expect(ctx.widgetContent).toBeUndefined();
	expect(ctx.statusText).toBeUndefined();
	widget.dispose();
});
