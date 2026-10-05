import { expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { makeRenderCtx } from "@xynogen/pix-pretty/test-utils";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

// Snapshot budget exception: voice needs two registered shells, the full 32/33-line preview, and private STT/settings states.
// ponytail: use real registered callbacks, not tool execution. Provider and raw-audio checks stay in the existing suites.
test("captures registered voice self shells without audio or provider execution", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	try {
		const { default: transcribe } = await import("./transcribe.ts");
		const { default: speak } = await import("./speak.ts");
		const tools: ToolDefinition[] = [];
		const pi = { registerTool: (tool: ToolDefinition) => tools.push(tool) };
		transcribe(pi as never);
		speak(pi as never);
		expect(tools.map((tool) => [tool.name, tool.renderShell])).toEqual([
			["transcribe", "self"],
			["speak", "self"],
		]);
		const theme = roleTheme();
		const output: string[] = [];
		const rows = (label: string, component: { render(width: number): string[] } | undefined) => {
			if (!component) throw new Error("Missing voice renderer");
			const rendered = captureRows(component, { width: 80, surface: "host-self" });
			output.push(label, ...rendered);
			return rendered;
		};
		for (const tool of tools) {
			const args =
				tool.name === "transcribe"
					? { file: "recordings/meeting.wav" }
					: { input: "Read the file. ".repeat(8) };
			const details =
				tool.name === "transcribe"
					? {
							_type: "transcribeResult",
							file: "recordings/meeting.wav",
							chars: 12_400,
							model: "dg/nova-3",
							provider: "9router",
							truncated: false,
						}
					: {
							_type: "ttsResult",
							output_path: "audio/speech.mp3",
							bytes: 21_168,
							model: "gpt-4o-mini-tts/alloy",
							provider: "openai",
							format: "mp3",
						};
			const result = {
				content: [{ type: "text" as const, text: "first\nsecond" }],
				details: { ...details, outcome: "success" },
			};
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: false,
				tools: {},
			}));
			rows(`${tool.name}:call`, tool.renderCall?.(args, theme as never, makeRenderCtx() as never));
			for (const [label, text, isPartial, isError] of [
				["partial", "processing...", true, false],
				["success", "first\nsecond", false, false],
				["empty", "", false, false],
				["error", "offline", false, true],
			] as const) {
				const rendered = rows(
					`${tool.name}:${label}`,
					tool.renderResult?.(
						{
							...result,
							content: [{ type: "text", text }],
							details: { ...details, outcome: isError ? "error" : "success" },
						},
						{ expanded: false, isPartial },
						theme as never,
						makeRenderCtx({ isError }) as never,
					),
				);
				if (!isPartial)
					expect(rendered.at(-1)).toBe(
						`<${isError ? "error" : "success"}>${"- ".repeat(40)}</${isError ? "error" : "success"}>`,
					);
			}
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: true,
				tools: {},
			}));
			for (const outcome of ["success", "error", "cancelled"])
				rows(
					`${tool.name}:collapsed-${outcome}`,
					tool.renderResult?.(
						{ ...result, details: { ...details, outcome } },
						{ expanded: false, isPartial: false },
						theme as never,
						makeRenderCtx({ isError: outcome !== "success", state: { collapsed: true } }) as never,
					),
				);
			rows(
				`${tool.name}:hidden-call`,
				tool.renderCall?.(
					args,
					theme as never,
					makeRenderCtx({ state: { collapsed: true } }) as never,
				),
			);
			rows(
				`${tool.name}:expanded-result`,
				tool.renderResult?.(
					result,
					{ expanded: true, isPartial: false },
					theme as never,
					makeRenderCtx({ expanded: true, state: { collapsed: true } }) as never,
				),
			);
			rows(
				`${tool.name}:expanded-call`,
				tool.renderCall?.(
					args,
					theme as never,
					makeRenderCtx({ expanded: true, state: { collapsed: true } }) as never,
				),
			);
		}
		const tool = tools[0]!;
		const recovery = {
			content: [
				{ type: "text" as const, text: "Writing failed: permission denied" },
				{ type: "text" as const, text: "recovered transcript" },
			],
			details: {
				_type: "transcribeResult",
				outcome: "error",
				file: "meeting.wav",
				chars: 20,
				provider: "9router",
				model: "dg/nova-3",
				write_error: "permission denied",
			},
		};
		for (const expanded of [false, true])
			rows(
				`transcribe:recovery-${expanded ? "expanded" : "collapsed"}`,
				tool.renderResult?.(
					recovery,
					{ expanded, isPartial: false },
					theme as never,
					makeRenderCtx({ expanded, isError: true, state: { collapsed: true } }) as never,
				),
			);
		rows(
			"transcribe:written",
			tool.renderResult?.(
				{
					...recovery,
					details: {
						...recovery.details,
						outcome: "success",
						write_error: undefined,
						output_path: "notes.md",
						chars: 12_400,
					},
				},
				{ expanded: false, isPartial: false },
				theme as never,
				makeRenderCtx({ state: { collapsed: true } }) as never,
			),
		);
		await fixture.runtime.update(collapseSection, (current) => ({
			...current,
			enabled: false,
			tools: {},
		}));
		for (const expanded of [false, true])
			rows(
				`transcribe:preview-${expanded ? "full" : "32"}`,
				tool.renderResult?.(
					{
						content: [
							{
								type: "text",
								text: Array.from({ length: 33 }, (_, i) => `line ${i + 1}`).join("\n"),
							},
							{ type: "image", data: "ignored", mimeType: "image/png" },
						],
						details: undefined,
					},
					{ expanded, isPartial: false },
					theme as never,
					makeRenderCtx({ expanded }) as never,
				),
			);
		expect(output.join("\n")).toMatchSnapshot();
	} finally {
		await fixture.restore();
	}
});
