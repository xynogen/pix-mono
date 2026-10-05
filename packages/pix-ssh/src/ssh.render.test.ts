import { expect, jest, mock, test } from "bun:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OverlayUI } from "@xynogen/pix-pretty/gate-overlay";
import { capturePi, makeRenderCtx } from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

import type { HostSpec } from "./lib.ts";

const actual = await import("./lib.ts");
const exec = await import("@xynogen/pix-runtime/exec");
const config = await import("@xynogen/pix-pretty/config");
// ponytail: two preview rows exercise overflow without repeating the default 80-row limit.
mock.module("@xynogen/pix-pretty/config", () => ({ ...config, MAX_PREVIEW_LINES: 2 }));
const binaries = await import("@xynogen/pix-runtime/binaries");
const spawnGuard = mock(() => {
	throw new Error("Capture must not start a process");
});
mock.module("@xynogen/pix-runtime/exec", () => ({
	...exec,
	spawnTool: spawnGuard,
	runTool: spawnGuard,
	runToolSync: spawnGuard,
}));
mock.module("@xynogen/pix-runtime/binaries", () => ({
	...binaries,
	requireTool: () => "/fixture/ssh",
}));
let probe: "ok" | "auth" = "ok";
const runner = mock(async () => ({ stdout: "done", stderr: "", code: 0 }));
const auth = mock(async () => true);
mock.module("./lib.ts", () => ({
	...actual,
	controlPathFor: () => "/fixture/control.sock",
	resolveSshHost: async (spec: HostSpec) => spec,
	resolveHostInfo: async () => ({ hostname: "node.invalid", user: "fixture", port: "2222" }),
	readSshConfigAliases: () => [{ alias: "fixture", hostname: "node.invalid", user: "fixture" }],
	probeKeyAuth: async () => probe,
	probePasswordAuth: auth,
	probeSudoNoPassword: async () => false,
	runSsh: runner,
	runTransfer: runner,
}));
const { default: register } = await import("./index.ts");
const theme = roleTheme();

function host() {
	const { pi, tool } = capturePi();
	register({ ...pi, events: createEventBus() } as unknown as ExtensionAPI);
	return tool;
}

test("SSH self-shell command, file, info and result states", async () => {
	const fixture = await withUiFixture();
	try {
		const tool = host();
		expect(tool.renderShell).toBe("self");
		const captures: Record<string, string[]> = {};
		const rows = (component: { render(width: number): string[] } | undefined, width = 80) => {
			if (!component) throw new Error("Missing SSH renderer");
			return captureRows(component, { width, surface: "host-self" });
		};
		const call = async (args: Record<string, unknown>, width = 80, expanded = false) => {
			fixture.setWidth(width);
			let invalidated!: () => void;
			const ready = new Promise<void>((resolve) => {
				invalidated = resolve;
			});
			const component = tool.renderCall?.(
				args,
				theme,
				makeRenderCtx({ expanded, invalidate: invalidated }),
			);
			if (args.action !== "info") await ready;
			return rows(component, width);
		};
		const target = { host: "fixture@node.invalid", command: "printf 'fixture'" };
		captures.call = await call(target);
		captures.sudo = await call({ ...target, sudo: true });
		const long = {
			...target,
			command:
				"printf 'a quoted fixture value that stays intact across command wrapping' && printf 'done'",
		};
		captures.wrap80 = await call(long);
		captures.wrap120 = await call(long, 120);
		captures.multiline = await call({ ...target, command: "printf 'first'\nprintf 'second'" });
		captures.file = await call({
			action: "file",
			host: "node.invalid",
			direction: "upload",
			source: "./fixture",
			destination: "/fixture",
		});
		captures.info = await call({ action: "info", host: "node.invalid" });
		captures.aliasCall = await call({ action: "info" });
		captures.hiddenCall = rows(
			tool.renderCall?.(target, theme, makeRenderCtx({ state: { collapsed: true } })),
		);
		captures.expandedCall = await call(target, 80, true);
		const result = (outcome: string, extra = {}, text = outcome): ToolResultLike => ({
			content: [{ type: "text", text }],
			details: {
				_type: "sshResult",
				host: "node.invalid",
				command: "printf fixture",
				outcome,
				...extra,
			},
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
		for (const errorKind of ["auth-ssh", "auth-sudo"])
			captures[errorKind] = render(
				result("error", { errorKind }, "Authentication failed"),
				false,
				false,
				false,
				true,
			);
		captures.genericError = render(
			{ content: [{ type: "text", text: "failed" }], details: undefined },
			false,
			false,
			false,
			true,
		);
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		const noUI = { hasUI: false, ui: { notify() {} } };
		captures.aliases = render(
			await execute("fixture", { action: "info" }, undefined, undefined, noUI),
		);
		captures.config = render(
			await execute(
				"fixture",
				{ action: "info", host: "node.invalid" },
				undefined,
				undefined,
				noUI,
			),
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

test("SSH package command and overwrite approval components, login then remote sudo", async () => {
	const fixture = await withUiFixture();
	jest.useFakeTimers();
	const captures: Record<string, string[]> = {};
	const credential = "fable";
	let captureError: unknown;
	try {
		for (const mode of ["command", "upload", "download", "passwords"] as const) {
			probe = mode === "passwords" ? "auth" : "ok";
			let stages = 0;
			const tool = host();
			const custom: OverlayUI["custom"] = async (factory, options) => {
				stages += 1;
				const stage = stages === 1 ? "login" : "sudo";
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
					if (mode !== "passwords")
						captures[mode] = captureRows(component, { width: 80, surface: "component" });
					else {
						component.handleInput("\r");
						component.handleInput(credential);
						captures[stage] = captureRows(component, { width: 80, surface: "component" });
						// Submit the login only. Deny remote sudo so no requested command can run.
						if (stage === "login") {
							component.handleInput("\r");
							await done;
						}
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
			const params = {
				host: `${mode}.invalid:2222`,
				reason: "Inspect the fixture",
				command: "id",
				sudo: mode === "passwords",
				...(mode === "upload" || mode === "download"
					? {
							action: "file",
							direction: mode,
							source: "./fixture",
							destination: "/fixture",
							recursive: mode === "upload",
						}
					: {}),
			};
			const result = await execute("fixture", params, undefined, undefined, {
				hasUI: true,
				ui: { custom, theme, notify() {} },
			});
			if (captureError) throw captureError;
			expect(result.details).toMatchObject({ outcome: "denied" });
			expect(stages).toBe(mode === "passwords" ? 2 : 1);
			expect(JSON.stringify(result)).not.toContain(credential);
		}
		expect(auth).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(captures)).not.toContain(credential);
		expect(runner).not.toHaveBeenCalled();
		expect(spawnGuard).not.toHaveBeenCalled();
		// ponytail: one JSON row array per state keeps the capture small without changing any row bytes.
		expect(
			Object.entries(captures)
				.map(([name, rows]) => `${name}: ${JSON.stringify(rows)}`)
				.join("\n"),
		).toMatchSnapshot();
	} finally {
		probe = "ok";
		jest.useRealTimers();
		await fixture.restore();
	}
});
