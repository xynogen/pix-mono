import { afterEach, expect, test } from "bun:test";
import { getKeybindings } from "@earendil-works/pi-tui";
import { config, pixRuntime } from "@xynogen/pix-runtime/config";
import type { ExtensionCommandContext } from "@xynogen/pix-runtime/host";
import { extensionsSection } from "@xynogen/pix-runtime/sections";
import { roleTheme } from "../../../scripts/ui-capture.ts";
import { confirmStaged } from "../src/extensions-panel.ts";

const WELCOME = "@xynogen/pix-welcome";
const FOOTER = "@xynogen/pix-footer";

/** A command context whose confirm overlay answers with `choice` (enter on the first or second item). */
function contextAnswering(choice: "allow" | "deny") {
	const events: string[] = [];
	const ui = {
		theme: roleTheme(),
		notify: (message: string) => events.push(`notify: ${message}`),
		custom: (
			factory: (...args: unknown[]) => {
				render(w: number): readonly string[];
				handleInput(data: string): void;
			},
		) =>
			new Promise((resolve) => {
				const view = factory(
					{ requestRender() {}, terminal: { rows: 24 } },
					roleTheme(),
					getKeybindings(),
					resolve,
				);
				events.push(`prompt: ${view.render(80).join("\n")}`);
				if (choice === "deny") view.handleInput("\x1b[B");
				view.handleInput("\r");
			}),
	};
	// SAFETY: confirmStaged only uses ui.custom, ui.notify and shutdown.
	const ctx = {
		hasUI: true,
		ui,
		shutdown: () => events.push("shutdown"),
	} as unknown as ExtensionCommandContext;
	return { ctx, events };
}

afterEach(async () => {
	await pixRuntime().update(extensionsSection, { disabled: [] });
});

test("two staged toggles ask once; allow writes both, then closes Pi", async () => {
	const { ctx, events } = contextAnswering("allow");
	await confirmStaged(ctx, [WELCOME, FOOTER]);
	expect(config(extensionsSection).disabled).toEqual([FOOTER, WELCOME]);
	expect(events.filter((e) => e.startsWith("prompt:"))).toHaveLength(1);
	expect(events[0]).toContain("Disable welcome, footer");
	expect(events.slice(1)).toEqual([
		"notify: Extensions: disable welcome, footer. Closing Pi — start it again to apply.",
		"shutdown",
	]);
});

test("deny writes nothing and keeps Pi running", async () => {
	const { ctx, events } = contextAnswering("deny");
	await confirmStaged(ctx, [WELCOME]);
	expect(config(extensionsSection).disabled).toEqual([]);
	expect(events.filter((e) => !e.startsWith("prompt:"))).toEqual([]);
});

test("turning gate off warns in the prompt", async () => {
	const { ctx, events } = contextAnswering("deny");
	await confirmStaged(ctx, ["@xynogen/pix-gate"]);
	expect(events[0]).toContain("Gate off: dangerous commands run without asking.");
	const plain = contextAnswering("deny");
	await confirmStaged(plain.ctx, [WELCOME]);
	expect(plain.events[0]).not.toContain("Gate off");
});

test("staged toggles that cancel out do not prompt", async () => {
	await pixRuntime().update(extensionsSection, { disabled: [WELCOME] });
	const { ctx, events } = contextAnswering("allow");
	await confirmStaged(ctx, [WELCOME]);
	expect(events).toEqual([]);
});
