import { expect, test } from "bun:test";
import { createEventBus, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import { ChipEditor } from "./chip-editor.ts";
import registerAsk from "./index.ts";
import { AskQuestionnaire } from "./questionnaire.ts";
import type { Params } from "./schema.ts";

test("ask self shell, questionnaire, preview, paging, and real chips", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	try {
		const theme = roleTheme() as unknown as Theme;
		const tui = { terminal: { rows: 18, cols: 120 }, requestRender() {} } as unknown as TUI;
		const kb = new KeybindingsManager({
			...TUI_KEYBINDINGS,
			"app.clipboard.pasteImage": { defaultKeys: "ctrl+v", description: "Paste image" },
		});
		const params: Params = {
			questions: [
				{
					question: "Pick an API?",
					header: "API",
					options: [
						{ label: "REST", description: "Plain requests", preview: "**GET** /items" },
						{ label: "GraphQL", description: "Typed queries", preview: "*query* items" },
					],
				},
			],
		};
		let tool:
			| {
					renderShell: string;
					renderCall(
						args: unknown,
						theme: Theme,
						context: unknown,
					): { render(width: number): string[] };
					renderResult(
						result: unknown,
						options: unknown,
						theme: Theme,
						context: unknown,
					): { render(width: number): string[] };
			  }
			| undefined;
		registerAsk({
			events: createEventBus(),
			registerTool(value: typeof tool) {
				tool = value;
			},
		} as never);
		if (!tool?.renderCall || !tool.renderResult) throw new Error("ask_user not registered");
		expect(tool.renderShell).toBe("self");
		const states: string[] = [];
		const capture = (
			name: string,
			component: { render(width: number): string[] },
			width = 80,
			surface: "component" | "host-self" = "component",
		) => {
			fixture.setWidth(width);
			states.push(`${name} @${width}`, ...captureRows(component, { width, surface }));
		};
		const context = (expanded = false, isError = false, collapsed = false) => ({
			state: { collapsed },
			expanded,
			isError,
			invalidate() {},
		});
		capture("call", tool.renderCall(params, theme, context()), 80, "host-self");
		const answer = {
			content: [{ type: "text" as const, text: "REST" }],
			details: {
				answers: [{ questionIndex: 0, question: "Pick an API?", kind: "option", answer: "REST" }],
			},
		};
		for (const [name, result, expanded, partial, error] of [
			["waiting", answer, false, true, false],
			["answered", answer, true, false, false],
			[
				"error",
				{ content: [{ type: "text" as const, text: "At least one question is required." }] },
				true,
				false,
				true,
			],
			[
				"cancelled",
				{ content: [{ type: "text" as const, text: "Cancelled" }], details: { cancelled: true } },
				false,
				false,
				false,
			],
		] as const)
			capture(
				name,
				tool.renderResult(
					result,
					{ expanded, isPartial: partial },
					theme,
					context(expanded, error),
				),
				80,
				"host-self",
			);
		await fixture.runtime.update(collapseSection, (current) => ({ ...current, enabled: true }));
		capture(
			"collapsed",
			tool.renderResult(
				answer,
				{ expanded: false, isPartial: false },
				theme,
				context(false, false, true),
			),
			80,
			"host-self",
		);
		capture(
			"hidden call",
			tool.renderCall(params, theme, context(false, false, true)),
			80,
			"host-self",
		);
		const q = new AskQuestionnaire(params, tui, theme, kb, () => {});
		capture("narrow preview", q);
		capture("split Markdown preview", q, 120);
		q.handleInput("g");
		capture("filtered", q);
		q.handleInput("\x7f");
		q.handleInput("\x1b[B");
		q.handleInput("\x1b[B");
		q.handleInput("\r");
		q.handleInput("custom");
		capture("freeform", q);
		const multi = new AskQuestionnaire(
			{
				questions: [
					{ ...params.questions[0]!, multiSelect: true },
					{ ...params.questions[0]!, header: "Next" },
				],
			},
			tui,
			theme,
			kb,
			() => {},
		);
		multi.handleInput(" ");
		(tui.terminal as unknown as { rows: number }).rows = 24;
		capture("checked, Confirm, and tabs", multi);
		(tui.terminal as unknown as { rows: number }).rows = 18;
		const paged = new AskQuestionnaire(
			{
				questions: [
					{
						...params.questions[0]!,
						options: params.questions[0]!.options.map((option) => ({
							...option,
							description: "Long description ".repeat(30),
						})),
					},
				],
			},
			tui,
			theme,
			kb,
			() => {},
		);
		paged.render(80);
		paged.handleInput("\x1b[6~");
		capture("description page", paged);
		const editor = new ChipEditor(
			tui,
			{
				borderColor: (s) => theme.fg("accent", s),
				selectList: {
					selectedPrefix: (s) => s,
					selectedText: (s) => s,
					description: (s) => s,
					scrollInfo: (s) => s,
					noMatch: (s) => s,
				},
			},
			kb,
			() => "/fixture/image.png",
		);
		editor.focused = true;
		editor.handleInput("\x16");
		capture("image chip", editor);
		editor.handleInput(`\x1b[200~${"line\n".repeat(12)}\x1b[201~`);
		capture("text and image chips", editor);
		expect(states.join("\n")).toMatchSnapshot();
	} finally {
		await fixture.restore();
	}
});
