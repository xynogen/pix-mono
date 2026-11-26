import { expect, spyOn, test } from "bun:test";
import { InteractiveMode, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { nativeMethodKey } from "@xynogen/pix-runtime/patch";
import { agentDir } from "@xynogen/pix-runtime/paths";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

test("registered models picker wraps the host selector, metadata, reload, and model choice", async () => {
	if (!agentDir().includes("pix-test-home-")) throw new Error("Test sandbox preload required");
	const cache = process.env.XDG_CACHE_HOME;
	const fixture = await withUiFixture({ hostTheme: true });
	const restores: { mockRestore(): void }[] = [];
	try {
		process.env.XDG_CACHE_HOME = `${fixture.agentDir}/capture-cache`;
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
		const { default: register } = await import("../src/models.ts");
		const { reasoningCatalog } = await import("../src/thinking.ts");
		const catalogSpy = spyOn(reasoningCatalog, "get").mockResolvedValue([]);
		restores.push(catalogSpy);
		type Component = {
			render(width: number): readonly string[];
			handleInput(data: string): void | Promise<void>;
		};
		let start: ((event: unknown, ctx: unknown) => void) | undefined;
		const proto = InteractiveMode.prototype;
		const nativeKey = nativeMethodKey("showModelSelector");
		const saved = ["showModelSelector", nativeKey].map(
			(key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const,
		);
		restores.push({
			mockRestore() {
				for (const [key, d] of saved) {
					if (d) Object.defineProperty(proto, key, d);
					else Reflect.deleteProperty(proto, key);
				}
			},
		});
		let level = "medium";
		const selected: unknown[] = [];
		let accept = true;
		register({
			on(name: string, hook: typeof start) {
				if (name === "session_start") start = hook;
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
		if (!start) throw new Error("session_start hook not registered");
		const models = [
			{ provider: "fixture", id: "alpha", name: "Alpha", contextWindow: 200_000, reasoning: true },
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
		const refreshCalls: { force?: boolean; signal?: AbortSignal }[] = [];
		let refreshGate: Promise<void> | undefined;
		const registry = {
			async refresh(options: { force?: boolean; signal?: AbortSignal } = {}) {
				refreshCalls.push(options);
				await refreshGate;
				return { aborted: false, errors: new Map<string, Error>() };
			},
			getAvailable: () => available,
			getAvailableOfType: async (type: string) =>
				type === "classifier"
					? [classifier]
					: [{ provider: "fixture", id: "painter", api: "openrouter-images" }],
		};
		const theme = roleTheme() as unknown as Theme;
		const states: string[] = [];
		const notifications: string[] = [];
		let mode: "capture" | "chat" | "classifier" | "image" | "thinking" | "cancel" = "capture";
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
						// Opening refresh runs in the background, then replaces the list with registry data.
						expect(refreshCalls.at(-1)?.force).toBe(false);
						capture("opening refresh");
						const opened = Promise.withResolvers<void>();
						completion = opened.resolve;
						await opened.promise;
						capture("current, scored, unscored, and missing");
						component.handleInput("\t");
						capture("classifier tab");
						component.handleInput("\x1b[C");
						expect(level).toBe("medium");
						component.handleInput("\t");
						capture("image tab");
						component.handleInput("\t");
						(tui.terminal as unknown as { rows: number }).rows = 16;
						component.handleInput("\x1b[C");
						expect(level).toBe("high");
						capture("thinking");
						component.handleInput("b");
						capture("filtered free model");
						component.handleInput("zzzz");
						capture("no match");
						component.handleInput("\x15");
						await Promise.resolve();
						const gate = Promise.withResolvers<void>();
						refreshGate = gate.promise;
						component.handleInput("\x12");
						expect(refreshCalls.at(-1)?.force).toBe(true);
						const rendered = Promise.withResolvers<void>();
						completion = rendered.resolve;
						try {
							capture("reload pending");
							// Fresh provider data lands in the registry before refresh() resolves.
							available = [
								...models,
								...Array.from({ length: 12 }, (_, i) => ({
									provider: "fixture",
									id: `extra-${i}`,
									name: `Extra ${i}`,
									contextWindow: 0,
								})),
							];
						} finally {
							gate.resolve();
							await rendered.promise;
							refreshGate = undefined;
						}
						expect(timers.size).toBe(0);
						for (let i = 0; i < 14; i++) component.handleInput("\x1b[B");
						capture("reload completed and height paging");
						available = models;
						component.handleInput("\x1b");
					} else if (mode === "thinking" || mode === "cancel") {
						expect(selected).toEqual([]);
						expect(component.render(80).join("\n")).toContain("[high]");
						if (mode === "thinking") {
							await component.handleInput("\x1b[C");
							expect(level).toBe("max");
							await component.handleInput("\x1b[D");
							expect(level).toBe("high");
							expect(selected).toHaveLength(1);
						}
						await component.handleInput("\x1b");
					} else {
						if (mode === "classifier") component.handleInput("\t");
						if (mode === "image") component.handleInput("\x1b[Z");
						component.handleInput("\r");
					}
					return result.promise;
				},
			},
		};
		// Pi's own entry point: InteractiveMode.showModelSelector, wrapped by the extension.
		start(undefined, ctx);
		const handler = async (search: string, _ctx: unknown) => {
			await Reflect.apply(Reflect.get(proto, "showModelSelector"), {}, search ? [search] : []);
		};
		await handler("", ctx);
		expect(refreshCalls.map((call) => call.force)).toEqual([false, true]);
		expect(refreshCalls.every((call) => call.signal?.aborted)).toBe(true);
		expect(selected).toEqual([]);
		mode = "classifier";
		await handler("", ctx);
		expect(selected).toEqual([]);
		expect(notifications.at(-1)).toContain("is a classifier model, not a chat model.");
		mode = "image";
		await handler("", ctx);
		expect(selected).toEqual([]);
		expect(notifications.at(-1)).toContain("is an image model, not a chat model.");
		mode = "chat";
		await handler("", ctx);
		expect(selected).toEqual([models[0]]);
		accept = false;
		await handler("", ctx);
		expect(notifications.at(-1)).toBe("Failed to switch to alpha");
		expect(states.join("\n")).toMatchSnapshot();
		accept = true;
		selected.length = 0;
		catalogSpy.mockResolvedValue([
			{ provider: "fixture", id: "alpha", levels: ["low", "medium", "high", "max"] },
		]);
		mode = "cancel";
		await handler("", ctx);
		expect(level).toBe("high");
		expect(selected).toEqual([]);
		mode = "thinking";
		await handler("", ctx);
		expect(selected[0]).toMatchObject({
			id: "alpha",
			thinkingLevelMap: { max: "max", xhigh: null },
		});
		selected.length = 0;
		mode = "chat";
		await handler("", ctx);
		expect(selected[0]).toMatchObject({
			id: "alpha",
			thinkingLevelMap: { high: "high", max: "max", xhigh: null },
		});
		expect(notifications.at(-1)).toBe("Thinking options for alpha: models.dev");
		selected.length = 0;
		// `/model beta` opens pre-filtered, so Enter picks beta, not the first row.
		await handler("beta", ctx);
		expect(selected[0]).toMatchObject({ id: "beta" });
	} finally {
		for (const restore of restores.reverse()) restore.mockRestore();
		if (cache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = cache;
		await fixture.restore();
	}
});
