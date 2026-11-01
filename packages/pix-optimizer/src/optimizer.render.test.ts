import { expect, spyOn, test } from "bun:test";
import { Text } from "@earendil-works/pi-tui";
import * as icons from "@xynogen/pix-pretty/icon-catalog";
import type { PackageSettings } from "@xynogen/pix-runtime";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import { registerOptCommand } from "./opt.ts";
import { type OptimizerHandle, OptimizerStatus, type OptimizerTool, STATUS_KEY } from "./status.ts";

test("actual optimizer overlay and pushed status without RTK initialization", async () => {
	const fixture = await withUiFixture();
	const originalListener = icons.onIconModeChange;
	let unsubscribe: (() => void) | undefined;
	const listener = spyOn(icons, "onIconModeChange").mockImplementation((callback) => {
		unsubscribe = originalListener(callback);
		return unsubscribe;
	});
	let overlay: { render(width: number): string[]; handleInput(data: string): void } | undefined;
	let open: PackageSettings["open"] | undefined;
	let rows = 40;
	let paints = 0;
	let close: ((value: null) => void) | undefined;
	let commandJob: Promise<void> | undefined;
	let options: unknown;
	let pushed = "";
	const states: Record<string, string[]> = {};
	const handles = Object.fromEntries(
		[
			["caveman", ["off", "lite", "full", "ultra", "micro"], "terse output"],
			["rtk", ["off", "on"], "prefix shell commands with rtk (token-optimized)"],
			["ponytail", ["off", "lite", "full", "ultra"], "lazy senior dev (minimal code)"],
		].map(([name, values, help]) => {
			let current = "off";
			return [
				name,
				{
					name,
					values,
					help: `${name} — ${help}`,
					current: () => current,
					run: (value: string) => {
						current = value;
					},
				},
			];
		}),
	) as Record<OptimizerTool, OptimizerHandle>;
	try {
		const status = new OptimizerStatus();
		registerOptCommand(
			{
				registerCommand(name: string) {
					expect(name).toBe("pix");
				},
				events: {
					emit() {},
					on(channel: string, listener: (data: unknown) => void) {
						if (channel !== "pix:settings") return;
						const entries = new Map<string, PackageSettings>();
						listener(entries);
						expect(entries.get("pix-optimizer")?.label).toBe("Optimizer");
						open = entries.get("pix-optimizer")!.open;
					},
				},
			} as never,
			handles,
			status,
		);
		if (!open) throw new Error("Optimizer settings did not register");
		const ctx = {
			ui: {
				theme: roleTheme(),
				setStatus: (key: string, text: string) => {
					expect(key).toBe(STATUS_KEY);
					pushed = text;
				},
				custom: (
					factory: (
						tui: unknown,
						theme: unknown,
						kb: unknown,
						done: (value: null) => void,
					) => typeof overlay,
					opts: unknown,
				) => {
					options = opts;
					return new Promise<null>((resolve) => {
						close = resolve;
						overlay = factory(
							{
								requestRender: () => paints++,
								terminal: {
									get rows() {
										return rows;
									},
								},
							},
							roleTheme(),
							undefined,
							resolve,
						);
					});
				},
			},
		};
		commandJob = open(ctx as never);
		if (!overlay) throw new Error("Optimizer overlay did not render");
		const component = overlay;
		expect(options).toEqual({
			overlay: true,
			overlayOptions: { anchor: "center", width: "65%", maxHeight: "80%", margin: 2 },
		});
		// ponytail: capture the real component at the 52-column overlay width for an 80-column terminal.
		const take = (name: string, width = 52) => {
			states[name] = captureRows(component, { width, surface: "component" });
		};
		const takeStatus = (name: string) => {
			status.paint(ctx as never);
			expect(pushed).toEndWith(" ");
			states[name] = captureRows({ render: () => [pushed] }, { width: 80, surface: "component" });
		};
		take("all off / terminal80 overlay52");
		takeStatus("status off / 80");
		component.handleInput("l");
		status.set("caveman", true, ctx as never);
		component.handleInput("j");
		component.handleInput("l");
		status.set("rtk", true, ctx as never);
		component.handleInput("j");
		component.handleInput("h");
		status.set("ponytail", true, ctx as never);
		take("mixed final selected / terminal80 overlay52");
		takeStatus("status all on / 80");
		status.set("rtk", false, ctx as never);
		takeStatus("status mixed / 80");
		rows = 14;
		take("constrained final selected / 52");
		component.handleInput("\u001b[5~");
		take("page up inspection / 52");
		component.handleInput("\u001b[6~");
		take("page down inspection / 52");
		rows = 10;
		take("height diagnostic / 52");
		rows = 40;
		take("wide / terminal120 overlay78", 78);
		expect(paints).toBe(7);
		component.handleInput("\u001b");
		await commandJob;
		let fallback = "";
		await open({
			ui: {
				notify: (text: string, level: string) => {
					expect(level).toBe("info");
					fallback = text;
				},
			},
		} as never);
		states["fallback / 80"] = captureRows(new Text(fallback, 0, 0), {
			width: 80,
			surface: "component",
		});
		expect(states).toMatchSnapshot();
	} finally {
		try {
			close?.(null);
			await commandJob;
		} finally {
			unsubscribe?.();
			listener.mockRestore();
			await fixture.restore();
		}
	}
});
