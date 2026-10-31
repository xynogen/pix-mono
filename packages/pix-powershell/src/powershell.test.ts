import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	capturePi,
	makeRenderCtx,
	makeTheme,
	makeToolContext,
} from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { currentPlatform } from "@xynogen/pix-runtime/platform";
import { createPixPowerShellExtension } from "./extension";
import { registerPowerShellTool, summarizePowerShellCommand } from "./powershell";

const okFactory = () => ({
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
});

describe("summarizePowerShellCommand", () => {
	it("keeps a pipeline as one step and counts statement separators", () => {
		expect(summarizePowerShellCommand("Get-ChildItem | Sort-Object Name")).toBe(
			"Get-ChildItem | Sort-Object Name",
		);
		expect(summarizePowerShellCommand("bun run check; bun run typecheck && bun test")).toBe(
			"bun run check · +2 steps",
		);
	});

	it("labels assignment and control-flow scripts by line count", () => {
		expect(summarizePowerShellCommand("$files = Get-ChildItem\n$files.Count")).toBe(
			"script · 2 lines",
		);
		expect(summarizePowerShellCommand("foreach ($p in 1..3) {\n  $p\n}")).toBe("script · 3 lines");
	});

	it("skips line and block comments", () => {
		expect(summarizePowerShellCommand("# note\n<# block\n comment #>\nGet-Date")).toBe("Get-Date");
		expect(summarizePowerShellCommand("   ")).toBe("command");
	});
});

describe("registerPowerShellTool", () => {
	it("renders the powershell label and a collapsed summary row", async () => {
		const { pi, tool, names } = capturePi();
		registerPowerShellTool(pi, okFactory, makeToolContext({ terminalWidth: () => 120 }));
		// ponytail: shared shell captures own layout. Keep the package label and self-shell wiring here.
		expect(tool.renderShell).toBe("self");
		const theme = makeTheme({ tag: true });
		const collapsed = tool.renderResult?.(
			{
				content: [{ type: "text", text: "a\nb" }],
				details: {
					_type: "bashResult",
					text: "a\nb",
					exitCode: 0,
					command: "Get-ChildItem -Force; Get-Date",
					durationMs: 1_200,
				},
			},
			undefined,
			theme,
			makeRenderCtx({ state: { collapsed: true } }),
		);

		let invalidated!: () => void;
		const ready = new Promise<void>((resolve) => {
			invalidated = resolve;
		});
		const callCtx = makeRenderCtx({ invalidate: invalidated });
		const call = tool.renderCall?.({ command: "Get-Date" }, theme, callCtx);
		await ready;
		expect(callCtx.state.commandPreview).toMatchObject({ language: "powershell" });
		expect(call?.render(120).join("\n")).toMatch(/powershell.*Get-Date/);
		expect(names).toEqual(["powershell"]);
		expect(collapsed?.getText()).toContain("<dim>Get-ChildItem -Force; Get-Date</dim>");
		expect(collapsed?.getText()).toMatch(/<muted>2 lines · [\d.]+s<\/muted>/);
	});

	it("maps an unknown cmdlet to exit 1", async () => {
		const { pi, tool } = capturePi();
		const message =
			"Get-Nope: The term 'Get-Nope' is not recognized as a name of a cmdlet, function, script file, or executable program.";
		registerPowerShellTool(
			pi,
			() => ({
				execute: async () => ({
					content: [{ type: "text" as const, text: message }],
					details: undefined,
				}),
			}),
			makeToolContext(),
		);
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		const result = await execute("c1", { command: "Get-Nope" }, undefined, undefined, {});
		expect(result.details).toMatchObject({ _type: "bashResult", exitCode: 1 });
	});
});

describe("pix-powershell extension", () => {
	for (const active of [
		["read", "bash"],
		["read", "bash", "powershell"],
	]) {
		it(`registers automatically on Windows with active tools: ${active.join(", ")}`, () => {
			const { pi: captured, names } = capturePi();
			const pi = { ...captured, getActiveTools: () => active } as unknown as ExtensionAPI;
			const extension = createPixPowerShellExtension({ platform: "win32", createTool: okFactory });
			extension(pi);
			extension(pi);
			expect(names).toEqual(["powershell"]);
			expect(pi.getActiveTools()).toEqual(active);
		});
	}

	it("uses pix-runtime host detection by default", () => {
		const { pi, names } = capturePi();
		createPixPowerShellExtension({ createTool: okFactory })(pi as unknown as ExtensionAPI);
		expect(names).toEqual(currentPlatform().os === "win32" ? ["powershell"] : []);
	});

	for (const platform of ["linux", "darwin", "android"] as const) {
		it(`is inert on ${platform}`, () => {
			const { pi, names } = capturePi();
			createPixPowerShellExtension({ platform, createTool: okFactory })(
				pi as unknown as ExtensionAPI,
			);
			expect(names).toEqual([]);
		});
	}
});
