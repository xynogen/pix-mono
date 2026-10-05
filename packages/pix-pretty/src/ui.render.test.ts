import { expect, jest, test } from "bun:test";
import { getKeybindings, Text } from "@earendil-works/pi-tui";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import { confirmOverlay } from "./confirm.ts";
import { parseDiff } from "./diff.ts";
import { renderSplit, renderUnified } from "./diff-render.ts";
import { showOverlay } from "./gate-overlay.ts";
import { frameLines } from "./modal-frame.ts";
import { openProgress } from "./progress.ts";
import { showSettingsPicker } from "./provider-picker.ts";
import { registerShellTool } from "./shell-tool.ts";
import { capturePi, makeRenderCtx, makeToolContext } from "./test-utils.ts";
import { frameToolResult, viewportTextConstructor } from "./utils.ts";

const theme = roleTheme();
test("shared shell completed, error, partial, collapsed and expanded captures", async () => {
	const fixture = await withUiFixture();
	try {
		const { pi, tool } = capturePi();
		registerShellTool(
			pi,
			() => ({ execute: async () => ({ content: [], details: undefined }) }),
			makeToolContext({ TextComponent: viewportTextConstructor(Text), terminalWidth: () => 80 }),
			{ name: "bash", summarize: (command) => command },
		);
		const output = {
			content: [{ type: "text", text: "one\n\ntwo" }],
			details: {
				_type: "bashResult",
				text: "one\n\ntwo",
				exitCode: 0,
				command: "printf fixture",
				durationMs: 100,
			},
		};
		for (const mode of [
			"success",
			"error",
			"partial",
			"collapsed",
			"expanded",
			"generic",
		] as const) {
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: mode === "collapsed" || mode === "expanded",
				tools: {},
			}));
			const component = tool.renderResult?.(
				mode === "generic"
					? { ...output, details: undefined }
					: mode === "error"
						? { ...output, details: { ...output.details, exitCode: 1 } }
						: output,
				{ isPartial: mode === "partial" },
				theme,
				makeRenderCtx({
					isError: mode === "error",
					expanded: mode === "expanded",
					state: { collapsed: mode === "collapsed" || mode === "expanded" },
				}),
			);
			if (!component) throw new Error("Missing shell renderer");
			expect(captureRows(component, { width: 80, surface: "component" })).toMatchSnapshot(mode);
		}
	} finally {
		await fixture.restore();
	}
});

test("frame, result close and unified/split diff actual captures", async () => {
	const fixture = await withUiFixture();
	try {
		const frame = frameLines({
			width: 80,
			title: "Fixture",
			lines: [theme.fg("text", "body"), ""],
			color: (text) => theme.fg("accent", text),
			bg: (text) => theme.bg("customMessageBg", text),
		});
		expect(
			captureRows({ render: () => frame }, { width: 80, surface: "component" }),
		).toMatchSnapshot("modal frame");
		for (const failed of [false, true])
			expect(
				captureRows(frameToolResult(new Text("body\n\nlast", 0, 0), theme, failed), {
					width: 80,
					surface: "component",
				}),
			).toMatchSnapshot(failed ? "error close" : "success close");
		const diff = parseDiff("alpha old\ncontext", "alpha new\ncontext");
		expect(
			captureRows(new Text(await renderUnified(diff, undefined), 0, 0), {
				width: 80,
				surface: "component",
			}),
		).toMatchSnapshot("unified");
		// ponytail: named 160-column split fixture crosses the production 150-column threshold.
		fixture.setWidth(160);
		expect(
			captureRows(new Text(await renderSplit(diff, undefined), 0, 0), {
				width: 160,
				surface: "component",
			}),
		).toMatchSnapshot("split 160");
	} finally {
		await fixture.restore();
	}
});

test("picker, gate, confirm and progress actual component captures", async () => {
	const fixture = await withUiFixture();
	jest.useFakeTimers();
	let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
	const ui = {
		custom: <T>(
			factory: (
				tui: { requestRender(): void; terminal: { rows: number } },
				th: typeof theme,
				kb: ReturnType<typeof getKeybindings>,
				done: (value: T) => void,
			) => NonNullable<typeof component>,
		): Promise<T | undefined> =>
			new Promise((resolve) => {
				component = factory(
					{ requestRender() {}, terminal: { rows: 24 } },
					theme,
					getKeybindings(),
					resolve,
				);
			}),
	};
	const capture = (name: string) => {
		if (!component) throw new Error("Missing overlay");
		expect(captureRows(component, { width: 80, surface: "component" })).toMatchSnapshot(name);
	};
	let progress: ReturnType<typeof openProgress> | undefined;
	try {
		const picker = showSettingsPicker(ui, {
			title: "Fixture settings",
			onAction: () => undefined,
			rows: () => [
				{
					key: "language",
					section: "STT",
					label: "language",
					value: "auto",
					editable: true,
					choices: [
						{ value: "auto", hint: "detect" },
						{ value: "en", hint: "English" },
					],
				},
			],
		});
		capture("picker overview");
		component?.handleInput("\r");
		for (const char of "en") component?.handleInput(char);
		capture("picker filtered choices");
		component?.handleInput("\x1b");
		component?.handleInput("\x1b");
		await picker;
		const gate = showOverlay(ui, {
			mode: "sudo",
			title: "Root request",
			body: ["Intent: inspect fixture", "Command: printf fixture"],
			timeoutMs: 0,
		});
		capture("gate approval");
		component?.handleInput("\r");
		component?.handleInput("abc");
		capture("gate masked password");
		component?.handleInput("\x1b");
		await gate;
		const confirm = confirmOverlay(ui, {
			title: "Apply fixture?",
			body: ["A fixed change"],
			timeoutMs: 0,
		});
		capture("confirm");
		component?.handleInput("\x1b");
		await confirm;
		progress = openProgress(ui, "Fixture progress");
		progress.setLabel("Checking fixture");
		capture("progress");
	} finally {
		progress?.close();
		component?.handleInput("\x1b");
		jest.useRealTimers();
		await fixture.restore();
	}
});
