import { expect, jest, test } from "bun:test";
import { getKeybindings } from "@earendil-works/pi-tui";
import type { OverlayUI } from "@xynogen/pix-pretty/gate-overlay";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import { classify, classifyPath, DEFAULT_PATH_RULES, DEFAULT_RULES } from "./lib.ts";
import {
	type GatePromptUI,
	PATH_SEVERITY_ICON,
	promptGateDecision,
	promptMergedGateDecision,
	promptPathDecision,
	SEVERITY_ICON,
} from "./prompt.ts";

test("captures actual gate severity, path and merged approval components", async () => {
	const fixture = await withUiFixture();
	jest.useFakeTimers();
	let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
	const captures: Record<string, string[]> = {};
	const ui: OverlayUI = {
		custom: (factory) =>
			new Promise((resolve) => {
				component = factory(
					{ requestRender() {}, terminal: { rows: 24 } },
					roleTheme(),
					getKeybindings(),
					resolve,
				);
			}),
	};
	const gateUi = ui as GatePromptUI;
	const capture = async (name: string, pending: ReturnType<typeof promptGateDecision>) => {
		try {
			if (!component) throw new Error("Missing gate overlay");
			captures[name] = captureRows(component, { width: 80, surface: "component" });
			component.handleInput("\r");
			const decision = await pending;
			expect(decision).toEqual(
				name === "critical" || name === "block" || name === "merged"
					? { approved: false, reason: "Blocked by user" }
					: { approved: true, reason: "Approved" },
			);
		} finally {
			component?.handleInput("\x1b");
		}
	};
	try {
		for (const [name, command] of Object.entries({
			critical: "rm -rf /",
			dangerous: "git push --force",
			risky: "git checkout --force main",
		})) {
			const hit = classify(command, DEFAULT_RULES);
			if (!hit) throw new Error("Missing command rule");
			await capture(name, promptGateDecision(gateUi, hit, command));
		}
		for (const [name, path] of Object.entries({ block: ".env", warn: ".npmrc" })) {
			const hit = classifyPath(path, "read", DEFAULT_PATH_RULES);
			if (!hit) throw new Error("Missing path rule");
			await capture(name, promptPathDecision(gateUi, hit, "read", path));
		}
		await capture(
			"merged",
			promptMergedGateDecision(
				gateUi,
				[
					{
						icon: SEVERITY_ICON.dangerous,
						label: "DANGEROUS",
						detail: "destructive git operation",
						tier: 3,
					},
					{
						icon: PATH_SEVERITY_ICON.block,
						label: "BLOCK",
						detail: ".env file (live secrets) — .env",
						tier: 4,
					},
				],
				"git push --force origin feature/long-approval-example && cat .env",
			),
		);
		expect(captures).toMatchSnapshot();
	} finally {
		component?.handleInput("\x1b");
		jest.useRealTimers();
		await fixture.restore();
	}
});
