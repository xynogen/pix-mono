import { expect, spyOn, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { agentDir } from "@xynogen/pix-runtime/paths";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

test("registered models picker isolates host patch, metadata, reload, and model choice", async () => {
	if (!agentDir().includes("pix-test-home-")) throw new Error("Test sandbox preload required");
	const cache = process.env.XDG_CACHE_HOME;
	const fixture = await withUiFixture({ hostTheme: true });
	const restores: { mockRestore(): void }[] = [];
	try {
		process.env.XDG_CACHE_HOME = `${fixture.agentDir}/capture-cache`;
		// Intercept before importing the registrar. HOME cannot contain the host disk patch.
		const patch = await import("./patch-builtin.ts");
		const patchSpy = spyOn(patch, "patchOutBuiltinModelCommand").mockImplementation(() => {});
		restores.push(patchSpy);
		const data = await import("@xynogen/pix-data");
		restores.push(
			spyOn(data.modelgrep, "getCached").mockImplementation(() => [
				{
					id: "fixture/alpha",
					name: "Alpha",
					context_length: 128_000,
					pricing: { input: 3, output: 15 },
					benchmarks: { artificial_analysis: { coding: 90, agentic: 90 } },
				},
				{
					id: "fixture/beta",
					name: "Beta",
					context_length: 64_000,
					pricing: { input: 0, output: 0 },
				},
			]),
		);
		restores.push(spyOn(data.benchlm, "getCached").mockImplementation(() => []));
		restores.push(
			spyOn(globalThis, "fetch").mockImplementation((() => {
				throw new Error("Network forbidden in capture");
			}) as unknown as typeof fetch),
		);
		const timers = new Set<number>();
		let id = 0;
		restores.push(
			spyOn(globalThis, "setInterval").mockImplementation((() => {
				timers.add(++id);
				return id;
			}) as never),
		);
		restores.push(
			spyOn(globalThis, "clearInterval").mockImplementation(((timer: number) => {
				timers.delete(timer);
			}) as never),
		);
		const { default: register } = await import("./models.ts");
		type Component = { render(width: number): string[]; handleInput(data: string): void };
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		let level = "medium";
		const selected: unknown[] = [];
		let accept = true;
		register({
			on() {},
			registerCommand(name: string, command: { handler: typeof handler }) {
				expect(name).toBe("models");
				handler = command.handler;
			},
			getThinkingLevel: () => level,
			setThinkingLevel(value: string) {
				level = value;
			},
			async setModel(model: unknown) {
				selected.push(model);
				return accept;
			},
		} as never);
		expect(patchSpy).toHaveBeenCalledTimes(1);
		if (!handler) throw new Error("models command not registered");
		const models = [
			{ provider: "fixture", id: "alpha", name: "Alpha", contextWindow: 200_000 },
			{ provider: "fixture", id: "beta", name: "Beta", contextWindow: 0 },
			{ provider: "fixture", id: "other", name: "Other", contextWindow: 0 },
		];
		const classifier = {
			provider: "fixture",
			id: "classify",
			api: "typesafe-system-one",
			contextWindow: 8_000,
		};
		let available: typeof models | Promise<typeof models> = models;
		let refreshes = 0;
		const registry = {
			refresh() {
				refreshes++;
			},
			getAvailable: () => available,
			getAvailableOfType: async () => [classifier],
		};
		const theme = roleTheme() as unknown as Theme;
		const states: string[] = [];
		const notifications: string[] = [];
		let mode: "capture" | "chat" | "classifier" = "capture";
		const ctx = {
			model: models[0],
			modelRegistry: registry,
			ui: {
				notify(text: string) {
					notifications.push(text);
				},
				custom: async (
					factory: (
						tui: TUI,
						theme: Theme,
						kb: KeybindingsManager,
						done: (value: string | null) => void,
					) => Component,
				) => {
					let component: Component;
					let completion: (() => void) | undefined;
					const tui = {
						terminal: { rows: 20, cols: 120 },
						requestRender() {
							if (
								component &&
								!component.render(80).some((row) => row.includes("Reloading models"))
							)
								completion?.();
						},
					} as unknown as TUI;
					const result = Promise.withResolvers<string | null>();
					component = factory(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS), result.resolve);
					const capture = (name: string, width = 80) => {
						fixture.setWidth(width);
						states.push(
							`${name} @${width}`,
							...captureRows(component, { width, surface: "component" }),
						);
					};
					if (mode === "capture") {
						capture("current, scored, unscored, missing, and classifier");
						(tui.terminal as unknown as { rows: number }).rows = 16;
						component.handleInput("\x1b[C");
						expect(level).toBe("high");
						capture("thinking");
						component.handleInput("b");
						capture("filtered free model");
						component.handleInput("zzzz");
						capture("no match");
						component.handleInput("\x15");
						const pending = Promise.withResolvers<typeof models>();
						available = pending.promise;
						component.handleInput("\x12");
						const rendered = Promise.withResolvers<void>();
						completion = rendered.resolve;
						try {
							capture("reload pending");
						} finally {
							pending.resolve([
								...models,
								...Array.from({ length: 12 }, (_, i) => ({
									provider: "fixture",
									id: `extra-${i}`,
									name: `Extra ${i}`,
									contextWindow: 0,
								})),
							]);
							await rendered.promise;
						}
						expect(timers.size).toBe(0);
						for (let i = 0; i < 14; i++) component.handleInput("\x1b[B");
						capture("reload completed and height paging");
						available = models;
						component.handleInput("\x1b");
					} else {
						if (mode === "classifier") component.handleInput("classify");
						component.handleInput("\r");
					}
					return result.promise;
				},
			},
		};
		await handler("", ctx);
		expect(refreshes).toBe(2);
		expect(selected).toEqual([]);
		mode = "classifier";
		await handler("", ctx);
		expect(selected).toEqual([]);
		expect(notifications.at(-1)).toContain("is a classifier model, not a chat model.");
		mode = "chat";
		await handler("", ctx);
		expect(selected).toEqual([models[0]]);
		accept = false;
		await handler("", ctx);
		expect(notifications.at(-1)).toBe("Failed to switch to alpha");
		expect(states.join("\n")).toMatchSnapshot();
	} finally {
		for (const restore of restores.reverse()) restore.mockRestore();
		if (cache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = cache;
		await fixture.restore();
	}
});
