import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	capturePi,
	makeRenderCtx,
	makeTheme,
	makeToolContext,
} from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
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
	it("renders the powershell label and a collapsed summary row", () => {
		const { pi, tool, names } = capturePi();
		registerPowerShellTool(pi, okFactory, makeToolContext({ terminalWidth: () => 120 }));
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

type Handler = () => void;

function fakeHost(activeTools: string[]) {
	const handlers = new Map<string, Handler[]>();
	const { pi: captured, names } = capturePi();
	const pi = {
		...captured,
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getActiveTools: () => activeTools,
	} as unknown as ExtensionAPI;
	const emit = (event: string) => {
		for (const handler of handlers.get(event) ?? []) handler();
	};
	return { pi, names, activeTools, start: () => emit("session_start"), emit };
}

describe("pix-powershell extension", () => {
	it("overrides powershell on Windows only when the user enabled it", () => {
		const host = fakeHost(["read", "bash", "powershell"]);
		createPixPowerShellExtension({ platform: "win32", createTool: okFactory })(host.pi);
		expect(host.names).toEqual([]); // nothing at load time
		host.start();
		host.start(); // re-emitted session_start must not re-register
		expect(host.names).toEqual(["powershell"]);
	});

	it("registers nothing when powershell is not an active tool", () => {
		const host = fakeHost(["read", "bash"]);
		createPixPowerShellExtension({ platform: "win32", createTool: okFactory })(host.pi);
		host.start();
		expect(host.names).toEqual([]);
	});

	it("registers before the next prompt when another extension enables powershell later", () => {
		// pix-toolbox restores toolbox.json in its own, later session_start handler.
		const host = fakeHost(["read", "bash"]);
		createPixPowerShellExtension({ platform: "win32", createTool: okFactory })(host.pi);
		host.start();
		expect(host.names).toEqual([]);
		host.activeTools.push("powershell");
		host.emit("before_agent_start");
		host.emit("before_agent_start");
		expect(host.names).toEqual(["powershell"]);
	});

	it("is inert off Windows", () => {
		const host = fakeHost(["powershell"]);
		createPixPowerShellExtension({ platform: "linux", createTool: okFactory })(host.pi);
		host.start();
		expect(host.names).toEqual([]);
	});
});
