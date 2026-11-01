import { describe, expect, jest, test } from "bun:test";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { rgbColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { padIcon } from "@xynogen/pix-pretty/utils";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { roleTheme, semanticRow, withUiFixture } from "../../../scripts/ui-capture.ts";
import registerTodo, { type TodoItem } from "./todo.ts";
import { renderTodoWidget } from "./widget.ts";

const baseTheme = roleTheme();
const theme = {
	...baseTheme,
	colors: { accent: rgbColor(100, 180, 240), muted: rgbColor(70, 70, 70) },
	style: (text: string) => baseTheme.fg("muted", text),
} as unknown as Theme;
const items: TodoItem[] = [
	{ id: 1, text: "Inspect inputs", status: "done" },
	{ id: 2, text: "Implement the widget", status: "in_progress" },
	{ id: 3, text: "Run checks", status: "pending" },
];

const plain = (rows: string[]) => rows.map(stripTerminalSequences);
const title = `${padIcon(icon("status.ok"), 3)} Todo     │ `;

describe("todo progress widget", () => {
	test("shows current position, status, and task on one content line", () => {
		const rows = renderTodoWidget(items, true, 80, theme);
		expect(plain(rows)).toEqual([
			"─".repeat(80),
			`${title}in progress · Implement the widget · 2/3`,
		]);
		expect(semanticRow(rows[1]!)).toMatch(
			/<accent>in progress<\/accent>.*<accent>Implement the widget<\/accent><muted> · 2\/3<\/muted>/,
		);
		expect(semanticRow(rows[1]!)).toMatch(
			/^<toolTitle>.+ Todo {4}<\/toolTitle><muted> │ <\/muted><accent>in progress<\/accent>/,
		);
	});

	test("shows blocked work alongside active work, including independent item positions", () => {
		const rows = plain(
			renderTodoWidget(
				[...items, { id: 8, text: "Waiting for access", status: "blocked" }],
				false,
				100,
				theme,
			),
		);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toBe(`${title}in progress · 1 blocked · Implement the widget · 1/4 done`);
	});

	test("shows next pending task without claiming it has started; caps independent tasks", () => {
		const pending: TodoItem[] = [{ id: 4, text: "Not started", status: "pending" }];
		expect(plain(renderTodoWidget(pending, true, 80, theme))[1]).toBe(
			`${title}pending · Not started · 1/1`,
		);
		const many = Array.from(
			{ length: 5 },
			(_, i): TodoItem => ({ id: i + 1, text: "Work", status: "in_progress" }),
		);
		const rows = plain(renderTodoWidget(many, false, 80, theme));
		expect(rows).toHaveLength(2);
		expect(rows[1]).toBe(`${title}in progress · 5 active · Work · 0/5 done`);
	});

	test("fades long descriptions and fits Unicode in narrow terminals", () => {
		const long = [{ ...items[1]!, text: "界e\u0301🙂".repeat(40) }];
		const rows = renderTodoWidget(long, true, 60, theme);
		expect(semanticRow(rows[1]!)).toMatch(/<accent>.*<\/accent><muted>.*<\/muted>/);
		for (let width = 0; width <= 100; width++) {
			for (const row of renderTodoWidget(long, true, width, theme)) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		}
		expect(renderTodoWidget([], true, 80, theme)).toEqual([]);
		expect(
			plain(
				renderTodoWidget(
					items.map((item) => ({ ...item, status: "done" })),
					true,
					80,
					theme,
				),
			)[1],
		).toMatch(/complete.*3\/3 done/);
	});

	test("updates on successful tool calls, restores state, and cleans up on complete, clear, and shutdown", async () => {
		const fixture = await withUiFixture();
		jest.useFakeTimers();
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		let tool!: ToolDefinition;
		let widget: { render(width: number): string[] } | undefined;
		const entries = [
			{ type: "custom", customType: "todo-state", data: { todos: items, ordered: true } },
		];
		const ctx = {
			ui: {
				setWidget(
					_key: string,
					factory?: (tui: unknown, theme: Theme) => typeof widget,
					options?: { placement: string },
				) {
					if (factory) expect(options?.placement).toBe("aboveEditor");
					widget = factory?.({}, theme);
				},
			},
			sessionManager: { getEntries: () => entries },
		};
		const show = () => plain(widget?.render(80) ?? []).join("\n");
		try {
			await fixture.runtime.update(collapseSection, (value) => ({ ...value, delaySec: 1 }));
			registerTodo({
				registerTool(value: ToolDefinition) {
					tool = value;
				},
				appendEntry() {},
				on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
					handlers.set(event, handler);
				},
			} as never);
			await handlers.get("session_start")!({}, ctx);
			expect(show()).toMatch(/Todo {5}│ in progress · Implement the widget · 2\/3/);
			const call = (params: Record<string, unknown>) =>
				tool.execute("widget-test", params, undefined, undefined, ctx as never);
			await call({ action: "update", id: 3, status: "in_progress" });
			expect(show()).toMatch(/Todo {5}│ in progress · Run checks · 3\/3/);
			const unchanged = show();
			expect((await call({ action: "update", id: 99, status: "done" })).isError).toBe(true);
			expect(show()).toBe(unchanged);
			await call({ action: "update", id: 3, status: "done" });
			expect(show()).toMatch(/complete.*3\/3 done/);
			jest.advanceTimersByTime(1_100);
			expect(widget).toBeUndefined();
			await call({ action: "set", items: "Fresh task" });
			expect(show()).toMatch(/Todo {5}│ pending · Fresh task · 1\/1/);
			await call({ action: "clear" });
			expect(widget).toBeUndefined();
			await call({ action: "set", items: "Finish" });
			await call({ action: "update", id: 1, status: "done" });
			await call({ action: "add", items: "More work" });
			jest.advanceTimersByTime(1_100);
			expect(show()).toMatch(/Todo {5}│ pending · More work · 2\/2/);
			entries.length = 0;
			await handlers.get("session_start")!({}, ctx);
			expect(widget).toBeUndefined();
			await call({ action: "set", items: "Shutdown cleanup" });
			await handlers.get("session_shutdown")!({}, ctx);
			expect(widget).toBeUndefined();
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			jest.useRealTimers();
			await fixture.restore();
		}
	});
});
