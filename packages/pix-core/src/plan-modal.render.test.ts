import { expect, spyOn, test } from "bun:test";
import { KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import { PlanModal, type PlanModalResult } from "./plan-modal.ts";
import type { Plan } from "./plan-mode.ts";

// ponytail: the actual modal returns decisions. No command handler deletes or writes a plan.
test("captures plan modal ages, modes, paging, and delete decisions", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	const clock = spyOn(Date, "now").mockReturnValue(200_000_000);
	try {
		const theme = roleTheme();
		const output: string[] = [];
		const plan: Plan = {
			file: "auth.md",
			title: "Auth",
			description: "Add login",
			body: "### Task 1: Read\nKeep the tool guard.",
			updated_at: 200_000_000 - 86_400_000,
		};
		let result: PlanModalResult | undefined;
		let renders = 0;
		const open = (plans: Plan[], mode = false, rows = 40) =>
			new PlanModal(
				plans,
				".pi/plans",
				mode,
				{ requestRender: () => renders++, terminal: { rows } } as unknown as TUI,
				theme as never,
				new KeybindingsManager(TUI_KEYBINDINGS),
				(value) => {
					result = value;
				},
			);
		const capture = (label: string, modal: PlanModal) =>
			output.push(label, ...captureRows(modal, { width: 80, surface: "component" }));
		capture("empty-off", open([]));
		capture("list-on", open([plan], true));
		capture(
			"long-description",
			open([{ ...plan, description: "Describe the lock and the tool guard. ".repeat(5) }]),
		);
		const modal = open([plan]);
		modal.handleInput("\x1b[B");
		modal.handleInput("\r");
		capture("detail", modal);
		modal.handleInput("\r");
		expect(result).toEqual({ kind: "execute", plan });
		const deletion = open([plan]);
		deletion.handleInput("\x1b[B");
		deletion.handleInput("d");
		capture("delete-confirm", deletion);
		deletion.handleInput("\x1b[B");
		deletion.handleInput("\r");
		capture("delete-cancel-detail", deletion);
		const long = open(
			[{ ...plan, body: Array.from({ length: 30 }, (_, i) => `Task row ${i + 1}`).join("\n") }],
			false,
			18,
		);
		long.handleInput("\x1b[B");
		long.handleInput("\r");
		capture("rows18-page1", long);
		long.handleInput("\x1b[6~");
		capture("rows18-page2", long);
		expect(renders).toBe(10);
		expect(output.join("\n")).toMatchSnapshot();
	} finally {
		clock.mockRestore();
		await fixture.restore();
	}
});
