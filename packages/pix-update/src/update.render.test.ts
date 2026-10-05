import { expect, jest, spyOn, test } from "bun:test";
import { FooterComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings } from "@earendil-works/pi-tui";
import type { ConfirmUI } from "@xynogen/pix-pretty/confirm";
import * as binaries from "@xynogen/pix-runtime/binaries";
import * as exec from "@xynogen/pix-runtime/exec";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import registerUpdate, { withSpinner } from "./update.ts";

test("captures actual update confirmation and fixed spinner footer statuses without a runner", async () => {
	const fixture = await withUiFixture();
	jest.useFakeTimers();
	const globals = globalThis as unknown as Record<symbol, unknown>;
	const keys = [
		Symbol.for("@earendil-works/pi-coding-agent:theme"),
		Symbol.for("@mariozechner/pi-coding-agent:theme"),
	];
	const previous = keys.map((key) => globals[key]);
	let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
	let pending: Promise<void> | undefined;
	try {
		for (const key of keys) globals[key] = roleTheme();
		const captures: Record<string, string[]> = {};
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		registerUpdate({
			registerFlag() {},
			on() {},
			registerCommand: (_name: string, command: { handler: typeof handler }) => {
				handler = command.handler;
			},
		} as never);
		if (!handler) throw new Error("Missing update command");
		const ui: ConfirmUI = {
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
		const chatContainer = new Container();
		const hostMethods = InteractiveMode.prototype as unknown as {
			showStatus(message: string): void;
			showExtensionNotify(message: string, type: string): void;
		};
		const host = { chatContainer, ui: { requestRender() {} }, showStatus: hostMethods.showStatus };
		const notices: [string, string][] = [];
		pending = handler("", {
			hasUI: true,
			ui: {
				...ui,
				notify: (message: string, type: string) => {
					notices.push([message, type]);
					hostMethods.showExtensionNotify.call(host, message, type);
				},
			},
		});
		if (!component) throw new Error("Missing update confirmation");
		captures.confirm = captureRows(component, { width: 80, surface: "component" });
		component.handleInput("\x1b");
		await pending;
		expect(notices).toEqual([["Update cancelled.", "info"]]);
		captures.cancelled = captureRows(chatContainer, { width: 80, surface: "component" });
		const statuses = new Map<string, string>();
		// ponytail: render the checked host footer with fixed observations, not a live session or host settings.
		const footer = {
			autoCompactEnabled: false,
			session: {
				state: {},
				sessionManager: { getCwd: () => "/fixture", getSessionName: () => undefined },
			},
			getSessionStats: () => ({
				usageTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				contextUsage: { contextWindow: 128000, percent: 0 },
			}),
			footerData: {
				getGitBranch: () => undefined,
				getAvailableProviderCount: () => 1,
				getExtensionStatuses: () => statuses,
			},
		};
		for (const fail of [false, true]) {
			const work = withSpinner(
				{
					setStatus: (key, value) => {
						if (value === undefined) statuses.delete(key);
						else statuses.set(key, value);
					},
				},
				"update",
				"Checking Pi version",
				async () => {
					captures[fail ? "statusFailure" : "status"] = captureRows(
						{ render: (width) => FooterComponent.prototype.render.call(footer as never, width) },
						{ width: 80, surface: "component" },
					);
					if (fail) throw new Error("fixture failure");
					return "done";
				},
			);
			if (fail) await expect(work).rejects.toThrow("fixture failure");
			else expect(await work).toBe("done");
			expect(statuses.size).toBe(0);
		}
		expect(captures).toMatchSnapshot();
	} finally {
		component?.handleInput("\x1b");
		try {
			await pending;
		} finally {
			jest.useRealTimers();
			for (const [index, key] of keys.entries()) {
				if (previous[index] === undefined) delete globals[key];
				else globals[key] = previous[index];
			}
			await fixture.restore();
		}
	}
});

test("captures registered update progress and completion with a guarded runner spy", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	jest.useFakeTimers();
	const original = exec.runTool;
	const guard = spyOn(binaries, "ensureTool").mockImplementation(() => {
		throw new Error("UNSAFE runner was reached");
	});
	const runner = spyOn(exec, "runTool");
	let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
	let pending: Promise<void> | undefined;
	const overlays: Promise<unknown>[] = [];
	try {
		// ponytail: spy on the existing runner binding. No installer, process, network, or production seam.
		const methods = InteractiveMode.prototype as unknown as {
			showStatus(message: string): void;
			showWarning(message: string): void;
			showError(message: string): void;
			showExtensionNotify(message: string, type: string): void;
		};
		const captures: Record<string, string[]> = {};
		for (const failed of [false, true]) {
			const prefix = failed ? "failure" : "success";
			const events: string[] = [];
			let customs = 0;
			let versions = 0;
			let notices = 0;
			const chatContainer = new Container();
			const host = {
				chatContainer,
				ui: { requestRender() {} },
				showStatus: methods.showStatus,
				showWarning: methods.showWarning,
				showError: methods.showError,
			};
			let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
			let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
			const queued: unknown[][] = [];
			registerUpdate({
				registerFlag() {},
				getFlag: () => true,
				sendUserMessage: (...args: unknown[]) => queued.push(args),
				on: (_name: string, callback: typeof sessionStart) => {
					sessionStart = callback;
				},
				registerCommand: (_name: string, command: { handler: typeof handler }) => {
					handler = command.handler;
				},
			} as never);
			if (!handler || !sessionStart) throw new Error("Missing update registration");
			await sessionStart({}, { ui: { notify() {} } });
			expect(queued).toEqual([["/update", { deliverAs: "followUp" }]]);
			runner.mockImplementation(async (name, args) => {
				events.push(`${name} ${args.join(" ")}`);
				if (name !== "pi") throw new Error("Unexpected fixture runner");
				if (args.join(" ") === "--version") {
					versions++;
					return { stdout: versions === 1 ? "0.99.1" : "0.99.2", stderr: "", code: 0 } as never;
				}
				if (!component) throw new Error("Missing progress component");
				captures[`${prefix}${args.includes("--self") ? "Pi" : "Packages"}`] = captureRows(
					component,
					{ width: 80, surface: "component" },
				);
				return {
					stdout: "",
					stderr: failed ? "permission denied" : "",
					code: failed ? 1 : 0,
				} as never;
			});
			const ui: ConfirmUI = {
				custom: (factory) => {
					const overlay = new Promise<never>((resolve) => {
						const index = ++customs;
						component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							roleTheme(),
							getKeybindings(),
							(value) => {
								events.push(index === 2 ? "close" : "confirm");
								resolve(value as never);
							},
						);
						if (index === 2)
							captures[`${prefix}Initial`] = captureRows(component, {
								width: 80,
								surface: "component",
							});
					});
					overlays.push(overlay);
					return overlay;
				},
			};
			pending = handler("", {
				hasUI: true,
				waitForIdle: async () => {
					events.push("idle");
				},
				shutdown: () => events.push("shutdown"),
				ui: {
					...ui,
					notify: (message: string, type: string) => {
						events.push(`notify ${type}`);
						chatContainer.clear();
						methods.showExtensionNotify.call(host, message, type);
						captures[`${prefix}Notice${++notices}`] = captureRows(chatContainer, {
							width: 80,
							surface: "component",
						});
					},
				},
			});
			if (!component) throw new Error("Missing update confirmation");
			component.handleInput("\r");
			await pending;
			expect(events).toEqual([
				"confirm",
				"idle",
				"pi --version",
				"pi update --self",
				"pi --version",
				`notify ${failed ? "error" : "info"}`,
				"pi update --extensions",
				`notify ${failed ? "error" : "info"}`,
				"close",
				"notify warning",
				"shutdown",
			]);
			expect(customs).toBe(2);
		}
		expect(guard).toHaveBeenCalledTimes(0);
		expect(runner).toHaveBeenCalledTimes(8);
		expect(captures).toMatchSnapshot();
	} finally {
		component?.handleInput("\x1b");
		try {
			await pending;
			await Promise.all(overlays);
		} finally {
			runner.mockRestore();
			guard.mockRestore();
			jest.useRealTimers();
			await fixture.restore();
		}
	}
	expect(exec.runTool).toBe(original);
});
