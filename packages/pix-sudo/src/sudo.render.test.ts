import { expect, jest, mock, test } from "bun:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OverlayUI } from "@xynogen/pix-pretty/gate-overlay";
import { capturePi, makeRenderCtx } from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

const actual = await import("./lib.ts");
const exec = await import("@xynogen/pix-runtime/exec");
const config = await import("@xynogen/pix-pretty/config");
// ponytail: two preview rows exercise overflow without repeating the default 80-row limit.
mock.module("@xynogen/pix-pretty/config", () => ({ ...config, MAX_PREVIEW_LINES: 2 }));
const spawnGuard = mock(() => {
	throw new Error("Capture must not start a process");
});
mock.module("@xynogen/pix-runtime/exec", () => ({
	...exec,
	spawnTool: spawnGuard,
	runTool: spawnGuard,
	runToolSync: spawnGuard,
}));
let cached = false;
const runner = mock(async () => ({ stdout: "done", stderr: "", code: 0 }));
const validator = mock(async () => ({ stdout: "", stderr: "", code: 0 }));
mock.module("./lib.ts", () => ({
	...actual,
	hasValidTicket: async () => cached,
	runWithSudo: runner,
	validateSudoPassword: validator,
}));
const { default: register } = await import("./index.ts");
const theme = roleTheme();

function host() {
	const { pi, tool } = capturePi();
	register({ ...pi, events: createEventBus() } as unknown as ExtensionAPI);
	return tool;
}

test("sudo self-shell calls and all result states", async () => {
	const fixture = await withUiFixture();
	try {
		const tool = host();
		expect(tool.renderShell).toBe("self");
		const captures: Record<string, string[]> = {};
		const rows = (component: { render(width: number): string[] } | undefined, width = 80) => {
			if (!component) throw new Error("Missing sudo renderer");
			return captureRows(component, { width, surface: "host-self" });
		};
		const call = async (command: string, width = 80, expanded = false) => {
			fixture.setWidth(width);
			let invalidated!: () => void;
			const ready = new Promise<void>((resolve) => {
				invalidated = resolve;
			});
			const component = tool.renderCall?.(
				{ command },
				theme,
				makeRenderCtx({ expanded, invalidate: invalidated }),
			);
			await ready;
			return rows(component, width);
		};
		captures.call = await call("printf 'fixture'");
		const long =
			"printf 'a quoted fixture value that stays intact across command wrapping' && printf 'done'";
		captures.wrap80 = await call(long);
		captures.wrap120 = await call(long, 120);
		captures.multiline = await call("printf 'first'\nprintf 'second'");
		captures.hiddenCall = rows(
			tool.renderCall?.({ command: "id" }, theme, makeRenderCtx({ state: { collapsed: true } })),
		);
		captures.expandedCall = await call("id", 80, true);
		const result = (outcome: string, extra = {}, text = outcome): ToolResultLike => ({
			content: [{ type: "text", text }],
			details: { _type: "sudoResult", command: "printf fixture", outcome, ...extra },
		});
		const render = (
			value: ToolResultLike,
			expanded = false,
			isPartial = false,
			collapsed = false,
			isError = false,
		) =>
			rows(
				tool.renderResult?.(
					value,
					{ isPartial },
					theme,
					makeRenderCtx({ expanded, isError, state: { collapsed } }),
				),
			);
		const output = result("success", { exitCode: 0, lineCount: 3, _render: "first\n\nlast" });
		captures.success = render(result("success", { exitCode: 0, _render: "done" }));
		captures.preview = render(output);
		captures.error = render(
			result("error", { exitCode: 1, errorKind: "exit-code", _render: "failed" }),
			false,
			false,
			false,
			true,
		);
		captures.partial = render(output, false, true);
		captures.expanded = render(output, true);
		captures.empty = render(result("success", { exitCode: 0 }));
		for (const outcome of ["awaiting-approval", "running", "denied", "timed-out", "cancelled"])
			captures[outcome] = render(result(outcome));
		captures.authentication = render(
			result("error", { errorKind: "authentication" }, "Authentication failed"),
			false,
			false,
			false,
			true,
		);
		captures.generic = render({ content: [{ type: "text", text: "done" }], details: undefined });
		captures.genericError = render(
			{ content: [{ type: "text", text: "failed" }], details: undefined },
			false,
			false,
			false,
			true,
		);
		await fixture.runtime.update(collapseSection, (current) => ({
			...current,
			enabled: true,
			tools: {},
		}));
		captures.collapsed = render(output, false, false, true);
		captures.collapsedError = render(result("denied"), false, false, true);
		captures.reopened = render(output, true, false, true);
		expect(captures.success?.at(-1)).toBe(`<success>${"- ".repeat(40)}</success>`);
		expect(captures.error?.at(-1)).toBe(`<error>${"- ".repeat(40)}</error>`);
		// ponytail: one JSON row array per state keeps the capture small without changing any row bytes.
		expect(
			Object.entries(captures)
				.map(([name, rows]) => `${name}: ${JSON.stringify(rows)}`)
				.join("\n"),
		).toMatchSnapshot();
		expect(spawnGuard).not.toHaveBeenCalled();
	} finally {
		await fixture.restore();
	}
});

test("sudo package approval components with masked input and cached ticket", async () => {
	const fixture = await withUiFixture();
	jest.useFakeTimers();
	const captures: Record<string, string[]> = {};
	const credential = "fable";
	let captureError: unknown;
	try {
		for (const mode of ["reason", "fallback", "cached"] as const) {
			cached = mode === "cached";
			const tool = host();
			const custom: OverlayUI["custom"] = async (factory, options) => {
				let finish!: (value: unknown) => void;
				const done = new Promise<unknown>((resolve) => {
					finish = resolve;
				});
				const component = factory(
					{ requestRender() {}, terminal: { rows: 24 } },
					theme,
					undefined,
					finish,
				);
				try {
					expect(options?.overlay).toBe(true);
					captures[mode] = captureRows(component, { width: 80, surface: "component" });
					if (mode === "reason") {
						component.handleInput("\r");
						component.handleInput(credential);
						captures.masked = captureRows(component, { width: 80, surface: "component" });
					}
				} catch (error) {
					// showOverlay does not forward a rejected custom promise. Report capture errors after denial.
					captureError = error;
				} finally {
					component.handleInput("\x1b");
					await done;
				}
				return (await done) as never;
			};
			const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
			const result = await execute(
				"fixture",
				{
					command: "id",
					...(mode === "fallback" ? {} : { reason: "Inspect the fixture identity" }),
				},
				undefined,
				undefined,
				{ hasUI: true, ui: { custom, theme, notify() {} } },
			);
			if (captureError) throw captureError;
			expect(result.details).toMatchObject({ outcome: "denied" });
		}
		expect(JSON.stringify(captures)).not.toContain(credential);
		expect(runner).not.toHaveBeenCalled();
		expect(validator).not.toHaveBeenCalled();
		expect(spawnGuard).not.toHaveBeenCalled();
		// ponytail: one JSON row array per state keeps the capture small without changing any row bytes.
		expect(
			Object.entries(captures)
				.map(([name, rows]) => `${name}: ${JSON.stringify(rows)}`)
				.join("\n"),
		).toMatchSnapshot();
	} finally {
		cached = false;
		jest.useRealTimers();
		await fixture.restore();
	}
});
