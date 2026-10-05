import { expect, test } from "bun:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import registerToolsNudge from "./tools.ts";

test("captures active and hidden tool warnings through the actual host notification renderer", async () => {
	const fixture = await withUiFixture();
	const globals = globalThis as unknown as Record<symbol, unknown>;
	const keys = [
		Symbol.for("@earendil-works/pi-coding-agent:theme"),
		Symbol.for("@mariozechner/pi-coding-agent:theme"),
	];
	const previous = keys.map((key) => globals[key]);
	try {
		for (const key of keys) globals[key] = roleTheme();
		// ponytail: use only checked 0.99.2 prototype render methods. Never construct the host or load settings.
		const methods = InteractiveMode.prototype as unknown as {
			showWarning(message: string): void;
			showExtensionNotify(message: string, type: string): void;
		};
		const captures: Record<string, string[]> = {};
		for (const [name, active] of [
			["active", ["read"]],
			["hidden", []],
		] as const) {
			let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
			registerToolsNudge({
				on: (_event: string, callback: typeof handler) => {
					handler = callback;
				},
				getActiveTools: () => active,
			} as never);
			if (!handler) throw new Error("Missing nudge handler");
			const chatContainer = new Container();
			const host = { chatContainer, ui: { requestRender() {} }, showWarning: methods.showWarning };
			const notices: string[] = [];
			const ctx = {
				ui: {
					notify: (message: string, type: string) => {
						notices.push(type);
						methods.showExtensionNotify.call(host, message, type);
					},
				},
			};
			expect(
				await handler({ toolName: "bash", input: { command: "cat src/auth.ts" } }, ctx),
			).toBeUndefined();
			expect(notices).toEqual(["warning"]);
			captures[name] = captureRows(chatContainer, { width: 80, surface: "component" });
		}
		expect(captures).toMatchSnapshot();
	} finally {
		for (const [index, key] of keys.entries()) {
			if (previous[index] === undefined) delete globals[key];
			else globals[key] = previous[index];
		}
		await fixture.restore();
	}
});
