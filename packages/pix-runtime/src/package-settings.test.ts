import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { registerPackageSettings, registerPixCommand } from "./pix-command.ts";
import { createIsolatedRuntime } from "./testing.ts";

function host(
	bus: EventEmitter,
	commands: Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>,
) {
	return {
		events: {
			emit: (channel: string, data: unknown) => {
				bus.emit(channel, data);
			},
			on: (channel: string, handler: (data: unknown) => void) => {
				bus.on(channel, handler);
			},
		},
		registerCommand(
			name: string,
			command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> },
		) {
			expect(commands.has(name)).toBe(false);
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
}

test("standalone settings render directly in /pix without a second overlay and disappear on unload", async () => {
	const iso = createIsolatedRuntime();
	try {
		await iso.runtime.init();
		const bus = new EventEmitter();
		const commands = new Map();
		const runtimeHost = host(bus, commands);
		registerPixCommand(runtimeHost, iso.runtime);
		let opened = 0;
		registerPackageSettings(host(bus, commands), {
			id: "pix-voice",
			label: "Voice",
			open: async (ctx) => {
				opened++;
				await ctx.ui.custom((tui, _theme, _kb, done) => ({
					// Fill the panel's whole terminal budget, like full-height pickers do.
					render: () => [
						"╭────────────────────────╮",
						"│ microphone: default    │",
						...Array.from(
							{
								length: Math.max(
									0,
									Math.floor((tui as { terminal: { rows: number } }).terminal.rows * 0.8) - 3,
								),
							},
							() => "│                        │",
						),
						"╰────────────────────────╯",
					],
					handleInput: (data: string) => {
						if (data === "\u001b") done(null);
					},
					invalidate() {},
				}));
			},
		});
		expect([...commands.keys()]).toEqual(["pix"]);
		let overlays = 0;
		const theme = {
			fg: (_c: string, s: string) => s,
			bg: (_c: string, s: string) => s,
			bold: (s: string) => s,
		};
		await commands.get("pix").handler("", {
			ui: {
				custom: async (
					factory: (
						tui: unknown,
						theme: unknown,
						kb: unknown,
						done: (value: unknown) => void,
					) => { render(width: number): string[]; handleInput(data: string): void },
				) =>
					new Promise((resolve) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 40 } },
							theme,
							getKeybindings(),
							resolve,
						);
						overlays++;
						for (let i = 0; i < 2; i++) component.handleInput("\t");
						const embedded = component.render(100);
						expect(embedded.join("\n")).toContain("microphone: default");
						// 40 rows at the default 80% cap: the tab row plus panel must fit 32 rows.
						expect(embedded.length).toBeLessThanOrEqual(32);
						expect(embedded.at(-1)).toMatch(/^╰─+╯$/);
						component.handleInput("\u001b[Z");
						expect(component.render(100).join("\n")).toMatch(/binary\.json/);
						component.handleInput("\u001b");
					}),
			},
		} as unknown as ExtensionCommandContext);
		expect(opened).toBe(1);
		expect(overlays).toBe(1);
		bus.removeAllListeners();
		const entries = new Map();
		bus.emit("pix:settings", entries);
		expect(entries.size).toBe(0);
		const standalone = new Map();
		registerPackageSettings(host(new EventEmitter(), standalone), {
			id: "pix-voice",
			label: "Voice",
			open: async () => {},
		});
		expect([...standalone.keys()]).toEqual(["pix"]);
	} finally {
		iso.cleanup();
	}
});
