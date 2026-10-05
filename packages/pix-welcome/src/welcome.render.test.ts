import { expect, test } from "bun:test";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import { type CheckResult, renderWelcome } from "./welcome.ts";

test("pure welcome banner pending, complete, mixed and clipped", async () => {
	const fixture = await withUiFixture();
	try {
		// ponytail: pure render only. Registration writes settings and starts external checks.
		const pending: CheckResult[] = [
			{ label: "PI", status: "pending" },
			{ label: "Auth", status: "ok", detail: "connected" },
			{ label: "Models", status: "ok", detail: "16 loaded" },
			{ label: "Tools", status: "pending" },
			{ label: "Skills", status: "pending" },
			{ label: "Ignore", status: "pending" },
		];
		const complete: CheckResult[] = [
			{ label: "PI", status: "ok", detail: "0.99.2" },
			...pending.slice(1, 3),
			{ label: "Tools", status: "ok", detail: "24 loaded" },
			{ label: "Skills", status: "ok", detail: "10 loaded (+2 manual)" },
			{ label: "Ignore", status: "ok", detail: "up to date" },
		];
		const mixed: CheckResult[] = [
			{ label: "PI", status: "pending" },
			{ label: "Auth", status: "error", detail: "registry unavailable" },
			{ label: "Models", status: "error", detail: "unavailable" },
			{ label: "Tools", status: "warn", detail: "none active" },
			{ label: "Skills", status: "ok", detail: "10 loaded" },
			{ label: "Ignore", status: "warn" },
		];
		const states: Record<string, string[]> = {};
		for (const [name, checks, model, cwd, width] of [
			["pending / 80", pending, "capture-model", "~/project", 80],
			["complete / 80", complete, "capture-model", "~/project", 80],
			["mixed / 80", mixed, "capture-model", "~/project", 80],
			["long / 80", complete, "model-".repeat(20), `~/${"directory/".repeat(20)}`, 80],
			["narrow / 10", mixed, "capture-model", "~/project", 10],
			["no checks / 80", [], "capture-model", "~/project", 80],
		] as const) {
			fixture.setWidth(width);
			states[name] = captureRows(
				{
					render: (columns) => renderWelcome(roleTheme(), model, cwd, [...checks], columns),
				},
				{ width, surface: "component" },
			);
		}
		expect(states).toMatchSnapshot();
	} finally {
		await fixture.restore();
	}
});
