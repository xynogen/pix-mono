import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { ProcMeta } from "../src/format.ts";
import { ProcModal, type ProcModalResult } from "../src/modal.ts";

const theme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
} as unknown as Theme;
const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
const ENTER = "\r";
const DOWN = "\u001b[B";
const ESC = "\u001b";

const meta = (handle: string, status: ProcMeta["status"], exitCode?: number): ProcMeta => ({
	handle,
	command: `run ${handle}`,
	cwd: "/repo",
	pid: 1,
	pgid: 1,
	startTime: Date.now() - 5000,
	status,
	exitCode,
	capped: false,
});
const dev = meta("proc-dev", "running");
const old = meta("proc-old", "exited", 1);

function open(procs = [dev, old], logs: Record<string, string[]> = {}) {
	let result: ProcModalResult | undefined | null = null;
	const m = new ProcModal(
		procs,
		async (h) => logs[h] ?? [],
		tui,
		theme,
		new KeybindingsManager(TUI_KEYBINDINGS),
		(r) => {
			result = r;
		},
	);
	return { m, result: () => result, text: () => m.render(100).join("\n") };
}

describe("ProcModal", () => {
	it("lists every process with its status inside a rounded frame", () => {
		const { text } = open();
		expect(text()).toMatch(
			/^╭[\s\S]*Processes[\s\S]*proc-dev[\s\S]*running[\s\S]*proc-old[\s\S]*exited\(1\)[\s\S]*╰/,
		);
	});

	it("shows an empty state when no process exists", () => {
		const { text } = open([]);
		expect(text()).toMatch(/no processes[\s\S]*proc tool/);
	});

	it("opens a process and shows its log tail and actions", async () => {
		const { m, text } = open([dev], { "proc-dev": ["Local: http://localhost:5173"] });
		m.handleInput(ENTER);
		await m.loading;
		expect(text()).toMatch(/proc-dev[\s\S]*run proc-dev[\s\S]*Local: http[\s\S]*Stop[\s\S]*Back/);
	});

	it("stops a running process from the list with s", () => {
		const { m, result } = open();
		m.handleInput("s");
		expect(result()).toEqual({ kind: "stop", handle: "proc-dev" });
	});

	it("removes a finished process with r, not a running one", () => {
		const { m, result } = open();
		m.handleInput("r");
		expect(result()).toBeNull();
		m.handleInput(DOWN);
		m.handleInput("r");
		expect(result()).toEqual({ kind: "rm", handle: "proc-old" });
	});

	it("offers Remove, not Stop, for a finished process", async () => {
		const { m, text, result } = open([old]);
		m.handleInput(ENTER);
		await m.loading;
		expect(text()).toMatch(/Remove[\s\S]*Back/);
		m.handleInput(ENTER);
		expect(result()).toEqual({ kind: "rm", handle: "proc-old" });
	});

	it("refresh shows a new status and keeps the selected row", () => {
		const { m, text, result } = open();
		m.handleInput(DOWN);
		m.refresh([{ ...dev, status: "exited", exitCode: 0 }, old]);
		expect(text()).toMatch(/0 running[\s\S]*proc-dev[\s\S]*exited\(0\)/);
		m.handleInput("r");
		expect(result()).toEqual({ kind: "rm", handle: "proc-old" });
	});

	it("refresh in the process view reloads the log and swaps Stop for Remove on exit", async () => {
		const logs: Record<string, string[]> = { "proc-dev": ["booting"] };
		const { m, text, result } = open([dev], logs);
		m.handleInput(ENTER);
		await m.loading;
		logs["proc-dev"] = ["booting", "ready on :5173"];
		m.refresh([{ ...dev, status: "exited", exitCode: 0 }]);
		await m.loading;
		expect(text()).toMatch(/exited\(0\)[\s\S]*ready on :5173[\s\S]*Remove/);
		m.handleInput(ENTER);
		expect(result()).toEqual({ kind: "rm", handle: "proc-dev" });
	});

	it("refresh stops re-reading the log once the process finished", async () => {
		const logs: Record<string, string[]> = { "proc-dev": ["done"] };
		const { m, text } = open([{ ...dev, status: "exited", exitCode: 0 }], logs);
		m.handleInput(ENTER);
		await m.loading;
		logs["proc-dev"] = ["changed on disk"];
		m.refresh([{ ...dev, status: "exited", exitCode: 0 }]);
		await m.loading;
		expect(text()).toMatch(/exited\(0\)[\s\S]*done/);
	});

	it("refresh goes back to the list when the open process is gone", async () => {
		const { m, text } = open([dev, old]);
		m.handleInput(ENTER);
		await m.loading;
		m.refresh([old]);
		expect(text()).toMatch(/Processes[\s\S]*proc-old/);
	});

	it("esc in the process view goes back to the list, esc in the list closes", async () => {
		const { m, text, result } = open([dev]);
		m.handleInput(ENTER);
		await m.loading;
		m.handleInput(ESC);
		expect(text()).toMatch(/Processes/);
		m.handleInput(ESC);
		expect(result()).toBeUndefined();
	});
});
