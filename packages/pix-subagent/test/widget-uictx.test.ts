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
import { AgentWidget, type UICtx } from "../src/ui/widget.ts";

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
