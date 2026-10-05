import { expect, test } from "bun:test";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { installChips } from "@xynogen/pix-pretty/chips";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import { attachPicker, pathToken } from "../src/editor.ts";

test("real editor captures plain tokens and both picker/chip adapter orders", async () => {
	const fixture = await withUiFixture();
	try {
		const roles = roleTheme();
		const theme: EditorTheme = {
			borderColor: (text) => roles.fg("border", text),
			selectList: {
				selectedPrefix: (text) => roles.fg("accent", text),
				selectedText: (text) => roles.fg("accent", text),
				description: (text) => roles.fg("dim", text),
				scrollInfo: (text) => roles.fg("muted", text),
				noMatch: (text) => roles.fg("muted", text),
			},
		};
		const kb = { matches: () => false } as unknown as KeybindingsManager;
		let notify!: () => void;
		const tui = {
			requestRender: () => notify(),
			terminal: { rows: 40, columns: 80 },
		} as unknown as TUI;
		const plain = new CustomEditor(tui, theme, kb);
		let completed = new Promise<void>((resolve) => {
			notify = resolve;
		});
		attachPicker(
			plain,
			tui,
			async () => "a b/c.ts",
			(message) => {
				throw new Error(message);
			},
		);
		plain.handleInput("@");
		await completed;
		expect(plain.getText()).toBe(pathToken("a b/c.ts"));
		expect(captureRows(plain, { width: 80, surface: "component" }).join("\n")).toMatchSnapshot(
			"plain token",
		);
		for (const pickerFirst of [false, true]) {
			const editor = new CustomEditor(tui, theme, kb);
			const picker = () =>
				attachPicker(
					editor,
					tui,
					async () => "packages/my folder/",
					(message) => {
						throw new Error(message);
					},
				);
			if (pickerFirst) {
				picker();
				installChips(editor);
			} else {
				installChips(editor);
				picker();
			}
			editor.handleInput(`\x1b[200~${"x".repeat(1001)}\x1b[201~`);
			completed = new Promise<void>((resolve) => {
				notify = resolve;
			});
			editor.handleInput("@");
			await completed;
			expect(editor.getExpandedText()).toBe(
				`<paste>${"x".repeat(1001)}</paste> <path>packages/my folder/</path> `,
			);
			expect(captureRows(editor, { width: 80, surface: "component" }).join("\n")).toMatchSnapshot(
				`chips picker first ${pickerFirst}`,
			);
		}
	} finally {
		await fixture.restore();
	}
});
