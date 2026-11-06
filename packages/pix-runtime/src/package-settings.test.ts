import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
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
					// Regression: the real TUI is a class; its prototype methods must reach the panel.
					redraw: () => (tui as { requestRender(): void }).requestRender(),
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
					handleInput(this: { redraw(): void }, data: string) {
						if (data === "\u001b") done(null);
						else this.redraw();
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
						// A class instance like Pi's TUI: requestRender lives on the prototype.
						let renders = 0;
						const tui = new (class {
							terminal = { rows: 40 };
							requestRender() {
								renders++;
							}
						})();
						const component = factory(tui, theme, getKeybindings(), resolve);
						overlays++;
						expect(component.render(100)[1]).toMatch(/Settings.*Voice.*Binaries/);
						component.handleInput("\t");
						const embedded = component.render(100);
						expect(embedded.join("\n")).toContain("microphone: default");
						const before = renders;
						component.handleInput("x");
						expect(renders).toBeGreaterThan(before);
						// 40 rows at the default 80% cap: the tab row plus panel must fit 32 rows.
						expect(embedded.length).toBeLessThanOrEqual(32);
						expect(embedded.at(-1)).toMatch(/^╰─+╯$/);
						component.handleInput("\u001b[Z");
						expect(component.render(100).join("\n")).toMatch(/icons\s+\S+/);
						component.handleInput("\u001b");
					}),
			},
		} as unknown as ExtensionCommandContext);
		expect(opened).toBe(1);
		expect(overlays).toBe(1);
		// `/pix voice` opens straight into the Voice tab; completion lists tabs by prefix.
		const pix = commands.get("pix");
		expect(pix.getArgumentCompletions("vo")).toEqual([{ value: "voice", label: "voice" }]);
		let direct = "";
		await pix.handler("voice", {
			ui: {
				custom: async (factory: (...a: unknown[]) => { render(w: number): string[] }) => {
					direct = factory(
						{ requestRender() {}, terminal: { rows: 40 } },
						theme,
						getKeybindings(),
						() => {},
					)
						.render(100)
						.join("\n");
					return null;
				},
			},
		} as unknown as ExtensionCommandContext);
		expect(direct).toContain("microphone: default");
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

test("all package tabs keep their active name visible in a narrow overlay", async () => {
	const iso = createIsolatedRuntime();
	try {
		await iso.runtime.init();
		const bus = new EventEmitter();
		const commands = new Map();
		registerPixCommand(host(bus, commands), iso.runtime);
		const labels = ["Tools", "MCP", "Optimizer", "Web", "Voice", "Notify"];
		for (const label of labels) {
			registerPackageSettings(host(bus, commands), {
				id: label,
				label,
				open: async (ctx) => {
					await ctx.ui.custom(() => ({
						render: () => [
							"╭────────────────────────╮",
							"│ fixture                │",
							"╰────────────────────────╯",
						],
						handleInput() {},
						invalidate() {},
					}));
				},
			});
		}
		const theme = {
			fg: (_c: string, s: string) => s,
			bg: (_c: string, s: string) => s,
			bold: (s: string) => s,
		};
		for (const label of labels) {
			await commands.get("pix").handler(label.toLowerCase(), {
				ui: {
					custom: async (
						factory: (...args: unknown[]) => { render(w: number): string[]; dispose(): void },
					) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 40 } },
							theme,
							getKeybindings(),
							() => {},
						);
						const lines = component.render(26);
						expect(lines[1]).toMatch(new RegExp(`${label}\\s+\\d+/8`));
						expect(lines.every((line) => visibleWidth(line) <= 26)).toBe(true);
						component.dispose();
					},
				},
			} as unknown as ExtensionCommandContext);
		}
	} finally {
		iso.cleanup();
	}
});
