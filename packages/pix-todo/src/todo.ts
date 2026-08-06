/**
 * todo.ts — durable execution checklist tool
 *
 * Extracted from the plan extension: the checklist is BUILD-phase execution
 * state that survives context compaction and session restore (persisted via
 * appendEntry("todo-state")). It is universal — other tools and workflow
 * extensions (like plan) drive it — so it lives in pix-core and registers the
 * `todo` tool. State, persistence, and restore are owned end to end here; the
 * checklist is seeded by the model via the tool's `set` action.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { formatCollapsedToolRow } from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { once } from "@xynogen/pix-runtime/once";
import { Type } from "typebox";

export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";

export interface TodoItem {
	id: number;
	text: string;
	status: TodoStatus;
}

type TodoAction = "list" | "set" | "add" | "update" | "clear";

interface TodoResultDetails {
	_type: "todoResult";
	action: TodoAction;
	outcome: "success" | "error";
	snapshot: TodoItem[];
}

/** Resolve the status glyph at render time so a live /pix mode switch applies. */
function todoGlyph(status: TodoStatus): string {
	const key = {
		pending: "status.pending",
		in_progress: "status.running",
		done: "status.done",
		blocked: "status.blocked",
	} as const;
	return icon(key[status]);
}

/** Theme color key per status — drives both glyph and (for active) row tint. */
const TODO_COLOR: Record<TodoStatus, string> = {
	pending: "muted",
	in_progress: "accent",
	done: "success",
	blocked: "error",
};

export type TodoTheme = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

/** One-line shared summary used once a card has collapsed. */
export function renderTodoSummaryLine(items: TodoItem[], theme: TodoTheme): string {
	if (!items.length) return formatCollapsedToolRow(theme, "todo", "empty");
	const done = items.filter((t) => t.status === "done").length;
	const active = items.find((t) => t.status === "in_progress");
	const blocked = items.filter((t) => t.status === "blocked").length;
	const meta = [`${done}/${items.length} done`, blocked > 0 ? `${blocked} blocked` : ""]
		.filter(Boolean)
		.join(" · ");
	const target = active
		? `#${active.id} ${active.text}`
		: done === items.length
			? "complete"
			: "checklist";
	return formatCollapsedToolRow(theme, "todo", target, meta, "success");
}

/** Colored checklist for the TUI: glyphs tinted by status, active row bold. */
export function renderTodoLines(items: TodoItem[], theme: TodoTheme): string {
	if (!items.length) return theme.fg("muted", "(no todos)");
	const done = items.filter((t) => t.status === "done").length;
	const head = theme.fg("accent", `Todos ${done}/${items.length} done:`);
	const lines = items.map((t) => {
		const color = TODO_COLOR[t.status];
		const glyph = theme.fg(color, todoGlyph(t.status));
		const body = `${t.id}. ${t.text}`;
		// Highlight the in-flight task so the eye lands on it first.
		const label =
			t.status === "in_progress"
				? theme.bold(theme.fg("accent", body))
				: theme.fg(t.status === "done" ? "muted" : "text", body);
		return `${glyph} ${label}`;
	});
	return `${head}\n${lines.join("\n")}`;
}

/**
 * Skip-guard: when marking an item done, check for earlier items still
 * pending or in_progress. Returns a warning string or "" if none skipped.
 */
function buildSkipWarning(items: TodoItem[], targetId: number): string {
	const skipped = items.filter(
		(o) => o.id < targetId && (o.status === "pending" || o.status === "in_progress"),
	);
	if (skipped.length === 0) return "";
	const ids = skipped.map((s) => `#${s.id} (${s.text})`).join(", ");
	return (
		`\n\n\u26a0 Earlier items still incomplete: ${ids}. ` +
		"Mark each done or blocked before proceeding."
	);
}

const parseItems = (raw: string): string[] =>
	raw
		.split("\n")
		.map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
		.filter(Boolean);

export default function registerTodo(pi: ExtensionAPI): void {
	once(pi, "pix-todo", () => {
		let todos: TodoItem[] = [];
		let nextTodoId = 1;

		function persistTodos() {
			pi.appendEntry("todo-state", { todos, nextTodoId });
		}

		function todoSummary(): string {
			if (!todos.length) return "(no todos)";
			const done = todos.filter((t) => t.status === "done").length;
			const lines = todos.map((t) => `${todoGlyph(t.status)} ${t.id}. ${t.text}`);
			return `Todos ${done}/${todos.length} done:\n${lines.join("\n")}`;
		}

		// Durable execution checklist for BUILD mode. Survives context compaction
		// and session restore. Workflows like plan instruct the model to seed it
		// from a plan's "Implementation Phases" so it stays anchored to plan.md.
		pi.registerTool({
			name: "todo",
			label: "Todo",
			// Avoid the default Box shell's one-cell x padding: Todo owns its compact
			// result row and should align its status glyph with other compact tools.
			renderShell: "self",
			description:
				"Track BUILD-phase execution progress. Durable across context compaction. Actions: list, set (replace all items from newline/numbered text), add, update (change one item's status), clear.",
			promptSnippet:
				"todo(action, items?, id?, status?, text?) — action: list|set|add|update|clear. Use to track implementation progress, especially when executing a plan.",
			promptGuidelines: [
				"When you start executing a multi-step plan in BUILD mode, seed the todo list with `todo(action:'set', items: <plan Implementation Phases>)`.",
				"Mark each item in_progress before working it via `todo(action:'update', id, status)`; opening one auto-closes every earlier item, so just open the next and skipped steps mark done themselves.",
				"When marking an item done, the tool checks for earlier incomplete items and warns you — resolve each skipped item (mark done or blocked) before moving on.",
				"Call `todo(action:'list')` to recover your place after long runs or context compaction.",
			],
			parameters: Type.Object({
				action: Type.Enum(["list", "set", "add", "update", "clear"] as const, {
					type: "string",
					description:
						'Required operation: "list" shows items; "set" replaces all from items; "add" appends items; "update" changes one item by id; "clear" removes all.',
				}),
				items: Type.Optional(
					Type.String({
						description: "For set/add: newline-separated or numbered list of todo texts.",
					}),
				),
				id: Type.Optional(Type.Number({ description: "For update: target todo id." })),
				status: Type.Optional(
					Type.Enum(["pending", "in_progress", "done", "blocked"] as const, {
						type: "string",
						description:
							'For update: "pending" = not started; "in_progress" = active; "done" = finished; "blocked" = cannot proceed.',
					}),
				),
				text: Type.Optional(
					Type.String({
						description: "For update: replacement text (optional).",
					}),
				),
			}),
			// The result already owns the checklist and its collapsed `✓ todo …` row.
			// Keeping the call renderer empty prevents a duplicate standalone header.
			renderCall() {
				return new Text("", 0, 0);
			},
			renderResult(result, options, theme, context) {
				const details = result.details as TodoResultDetails | undefined;
				const resultText = result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				if (context.isError || details?.outcome === "error" || !details) {
					return new Text(resultText, 0, 0);
				}

				const collapsed = tickCollapse(
					"todo",
					context.state as CollapseState,
					context.invalidate,
					options.expanded,
				);
				const render = collapsed ? renderTodoSummaryLine : renderTodoLines;
				return new Text(render(details.snapshot, theme as TodoTheme), 0, 0);
			},

			async execute(_id, params) {
				const action = params.action as TodoAction;
				const details = (outcome: TodoResultDetails["outcome"]): TodoResultDetails => ({
					_type: "todoResult",
					action,
					outcome,
					snapshot: todos.map((item) => ({ ...item })),
				});
				const ok = (text: string) => ({
					content: [{ type: "text" as const, text }],
					details: details("success"),
				});
				const fail = (text: string) => ({
					content: [{ type: "text" as const, text }],
					details: details("error"),
					isError: true,
				});
				switch (params.action) {
					case "list":
						return ok(todoSummary());

					case "set": {
						const texts = parseItems(params.items ?? "");
						if (!texts.length) return fail("set requires non-empty `items`.");
						nextTodoId = 1;
						todos = texts.map((text) => ({
							id: nextTodoId++,
							text,
							status: "pending" as TodoStatus,
						}));
						persistTodos();
						return ok(todoSummary());
					}

					case "add": {
						const texts = parseItems(params.items ?? "");
						if (!texts.length) return fail("add requires non-empty `items`.");
						for (const text of texts) todos.push({ id: nextTodoId++, text, status: "pending" });
						persistTodos();
						return ok(todoSummary());
					}

					case "update": {
						const t = todos.find((x) => x.id === params.id);
						if (!t) return fail(`No todo with id ${params.id}.`);
						let skipWarning = "";
						if (params.status) {
							// Sequential-progress invariant: opening a task means everything
							// before it is finished. Cascade-close every earlier pending or
							// in_progress item (ids are sequential) so the model never has to
							// mark skipped steps done by hand. `blocked` is left untouched.
							if (params.status === "in_progress")
								for (const other of todos)
									if (
										other.id < t.id &&
										(other.status === "pending" || other.status === "in_progress")
									)
										other.status = "done";

							if (params.status === "done") skipWarning = buildSkipWarning(todos, t.id);

							t.status = params.status;
						}
						if (params.text) t.text = params.text;
						persistTodos();
						return ok(todoSummary() + skipWarning);
					}

					case "clear":
						todos = [];
						nextTodoId = 1;
						persistTodos();
						return ok("Todos cleared.");

					default:
						return fail(`Unknown action: ${String(params.action)}`);
				}
			},
		});

		// ── Turn-based reminder ─────────────────────────────────────────────
		// Every TODO_REMINDER_INTERVAL turns, inject the current todo summary
		// into the system prompt so the model stays aware of pending work and
		// can't hand-wave or ignore incomplete items.
		const TODO_REMINDER_INTERVAL = 10;
		let todoTurnCount = 0;

		pi.on("before_agent_start", async (event) => {
			todoTurnCount++;
			// Only inject when there are active (non-empty) todos
			if (todos.length === 0) return;
			// Check if any items are still incomplete
			const hasIncomplete = todos.some((t) => t.status === "pending" || t.status === "in_progress");
			if (!hasIncomplete) return;
			// Fire on every Nth turn
			if (todoTurnCount % TODO_REMINDER_INTERVAL !== 0) return;

			const reminder =
				"Todo reminder — incomplete items remain:\n" +
				todoSummary() +
				"\nCall `todo(action:'list')` to review, then continue working through pending items.";

			const existing = event.systemPrompt ?? "";
			return { systemPrompt: existing ? `${existing}\n\n${reminder}` : reminder };
		});

		// Restore the checklist from session entries so it survives restart.
		pi.on("session_start", async (_event, ctx) => {
			const entries = ctx.sessionManager.getEntries() as Array<{
				type: string;
				customType?: string;
				data?: { todos?: TodoItem[]; nextTodoId?: number };
			}>;
			const lastTodo = entries
				.filter((e) => e.type === "custom" && e.customType === "todo-state")
				.pop();
			if (Array.isArray(lastTodo?.data?.todos)) {
				todos = lastTodo.data.todos;
				nextTodoId = lastTodo.data.nextTodoId ?? todos.reduce((m, t) => Math.max(m, t.id + 1), 1);
			}
		});
	});
}
