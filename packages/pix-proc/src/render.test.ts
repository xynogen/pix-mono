import { describe, expect, test } from "bun:test";
import { rgbColor } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { COLLAPSED_TOOL_GLYPH } from "@xynogen/pix-pretty/utils";
import registerRunner from "./index.ts";

type Component = { render(width: number): string[] };
type Tool = {
	renderCall(args: unknown, theme: unknown, context: unknown): Component;
	renderResult(result: unknown, options: unknown, theme: unknown, context: unknown): Component;
};

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function tool(): Tool {
	let registered: Tool | undefined;
	registerRunner({
		on() {},
		registerTool(value: Tool) {
			registered = value;
		},
		registerCommand() {},
	} as never);
	if (!registered) throw new Error("proc tool was not registered");
	return registered;
}

function result(ok: boolean, lines: string[], error?: string) {
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { _type: "procResult", action: "start", ok, lines, error },
		isError: !ok,
	};
}

describe("proc renderer", () => {
	test("defers command highlighting while arguments stream", async () => {
		const host = tool();
		const theme = { ...plainTheme, fg: (key: string, text: string) => `<${key}>${text}</${key}>` };
		let invalidations = 0;
		const ctx = {
			state: {},
			expanded: false,
			executionStarted: false,
			invalidate: () => invalidations++,
		};
		for (const command of ["echo", "echo hello"]) {
			const component = host.renderCall({ action: "start", command }, theme, ctx);
			const rows = component.render(80);
			await Promise.resolve();
			expect(component.render(80)).toEqual(rows);
			expect(invalidations).toBe(0);
		}
		ctx.executionStarted = true;
		host.renderCall({ action: "start", command: "echo hello" }, theme, ctx);
		await Promise.resolve();
		expect(invalidations).toBe(1);
	});
	test("wraps long commands with the shared parameter separator", () => {
		const lines = tool()
			.renderCall(
				{ action: "start", command: "npm run dev && echo a long command with several parameters" },
				plainTheme,
				{ state: {}, invalidate() {}, expanded: false },
			)
			.render(32);
		expect(lines[0]).toContain("proc · start ·");
		expect(lines.length).toBeGreaterThan(2);
		expect(lines[1]).toMatch(/^ {2}/);
	});
	test("collapsed success shows the process glyph and a solid close", () => {
		const rendered = tool()
			.renderResult(
				result(true, ["proc-swift-otter-42 started — npm run dev (pid 1234)"]),
				{ expanded: false, isPartial: false },
				plainTheme,
				{ state: { collapsed: true }, invalidate() {}, expanded: false, isError: false },
			)
			.render(160);
		expect(rendered[0]).toContain(icon("status.ok"));
		expect(rendered[0]).toContain("proc-swift-otter-42 started");
		expect(rendered).toHaveLength(1);
	});

	test("collapsed error shows the error glyph and the message", () => {
		const rendered = tool()
			.renderResult(
				result(false, [], "start requires a command"),
				{ expanded: false, isPartial: false },
				plainTheme,
				{ state: { collapsed: true }, invalidate() {}, expanded: false, isError: true },
			)
			.render(80)
			.join("\n");
		expect(rendered).toContain(COLLAPSED_TOOL_GLYPH.error);
		expect(rendered).toContain("start requires a command");
	});

	test("expanded success and error close with a status-colored rule", () => {
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => text,
		};
		const host = tool();
		const success = host
			.renderResult(result(true, ["started"]), { expanded: true, isPartial: false }, theme, {
				state: { collapsed: true },
				invalidate() {},
				expanded: true,
				isError: false,
			})
			.render(20);
		const error = host
			.renderResult(result(false, [], "failed"), { expanded: true, isPartial: false }, theme, {
				state: { collapsed: true },
				invalidate() {},
				expanded: true,
				isError: true,
			})
			.render(20);
		expect(success.at(-1)).toBe(`<success>${"─".repeat(20)}</success>`);
		expect(error.at(-1)).toBe(`<error>${"─".repeat(20)}</error>`);
	});
	test("renders every action with a separated title and no dangling parameter separator", () => {
		const host = tool();
		for (const action of ["start", "list", "logs", "stop", "rm"]) {
			const line = host
				.renderCall({ action }, plainTheme, { state: {}, invalidate() {}, expanded: false })
				.render(80)[0]!;
			expect(line).toContain(`proc · ${action}`);
			expect(line.trimEnd().endsWith("·")).toBe(false);
		}
	});

	test("renders process metadata and warnings separately from log output", () => {
		const host = tool();
		const theme = {
			...plainTheme,
			fg: (key: string, text: string) => `<${key}>${text}</${key}>`,
			colors: {
				dim: rgbColor(136, 136, 136),
				muted: rgbColor(102, 102, 102),
				accent: rgbColor(255, 255, 255),
			},
			style: (text: string) => text,
		};
		const value = {
			...result(true, []),
			details: {
				_type: "procResult",
				action: "start",
				ok: true,
				lines: [],
				handle: "proc-dev",
				processes: [
					{
						handle: "proc-dev",
						command: "TOKEN=private npm run dev",
						cwd: "/project",
						pid: 42,
						pgid: 42,
						status: "running",
						startTime: Date.now(),
						capped: false,
						foreign: true,
					},
				],
				notes: ["log stopped: disk full"],
				output: ["ready on :5173"],
				logPath: "/logs/proc-dev.log",
			},
		};
		const rendered = host
			.renderResult(value, { expanded: true, isPartial: false }, theme, {
				state: {},
				invalidate() {},
				expanded: true,
				isError: false,
			})
			.render(120)
			.join("\n");
		expect(rendered).toContain("proc · start");
		expect(rendered).toContain("pid 42 · /project · read-only");
		expect(rendered).toContain("<warning>log stopped: disk full</warning>");
		expect(rendered).toContain("Full log · /logs/proc-dev.log");
		expect(rendered).toContain("ready on :5173");
		expect(rendered).not.toContain("private");
	});

	test("bounds previews without dropping expanded output", () => {
		const host = tool();
		const output = Array.from({ length: 40 }, (_, i) => `output-line-${i + 1}`);
		const value = {
			...result(true, []),
			details: {
				_type: "procResult",
				action: "logs",
				ok: true,
				lines: output,
				handle: "proc-dev",
				output,
			},
		};
		for (const expanded of [false, true]) {
			const rendered = host
				.renderResult(value, { expanded, isPartial: true }, plainTheme, {
					state: {},
					invalidate() {},
					expanded,
					isError: false,
				})
				.render(100)
				.join("\n");
			expect(rendered.includes("output-line-40")).toBe(expanded);
			if (!expanded) expect(rendered).toContain("32 more lines");
		}
	});

	test("collapsed result never flattens logs into the summary", () => {
		const host = tool();
		const value = {
			...result(true, []),
			details: {
				_type: "procResult",
				action: "logs",
				ok: true,
				lines: ["do not repeat"],
				output: ["do not repeat"],
				handle: "proc-dev",
			},
		};
		const rows = host
			.renderResult(value, { expanded: false, isPartial: false }, plainTheme, {
				state: { collapsed: true },
				invalidate() {},
				expanded: false,
				isError: false,
			})
			.render(32);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("proc · logs");
		expect(rows[0]).not.toContain("do not repeat");
	});
});
