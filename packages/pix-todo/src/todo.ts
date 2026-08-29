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
import { dotJoin, formatCollapsedToolRow, termW } from "@xynogen/pix-pretty/utils";
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
	pending: "text",
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
	const meta = dotJoin([`${done}/${items.length} done`, blocked > 0 && `${blocked} blocked`]);
	const target = active
		? `#${active.id} ${active.text}`
		: done === items.length
			? "complete"
			: "checklist";
	// Blocked work with nothing active is not a success — surface the warning glyph
	// (text meta already names the block count) so status is not color-only.
	const status = blocked > 0 && !active && done !== items.length ? "warning" : "success";
	return formatCollapsedToolRow(theme, "todo", target, meta, status);
}

/** Kanban columns in workflow order: To Do → In Progress → Done → Blocked. */
const KANBAN_LANES: ReadonlyArray<{ status: TodoStatus; title: string }> = [
	{ status: "pending", title: "To Do" },
	{ status: "in_progress", title: "In Progress" },
	{ status: "done", title: "Done" },
	{ status: "blocked", title: "Blocked" },
];

const COL_SEP = " │ "; // vertical separator between columns
const MIN_COL_WIDTH = 12;

/** Pad plain text to `w` (truncate with … if longer) BEFORE coloring, so ANSI
 *  codes never throw off column alignment. */
function cell(text: string, w: number): string {
	if (text.length > w) return `${text.slice(0, Math.max(0, w - 1))}…`;
	return text.padEnd(w);
}

/**
 * Horizontal kanban board for the TUI: one column per status, cards stacked
 * under each header, aligned into a table. Each column sizes to its own widest
 * cell (header or card) so the table stays compact, capped at the even terminal
 * split so a single long card can't blow out the row (text truncates with …).
 * ponytail: per-column shrink-to-fit, capped at even split. Upgrade path is a
 * width-responsive fallback to stacked swimlanes on very narrow terminals
 * (see pix-sec design doc).
 */
export function renderTodoLines(items: TodoItem[], theme: TodoTheme): string {
	if (!items.length) return theme.fg("muted", "(no todos)");

	const cols = KANBAN_LANES.map((lane) => {
		const laneItems = items.filter((t) => t.status === lane.status);
		return {
			...lane,
			items: laneItems,
			header: `${lane.title} (${laneItems.length})`,
			cards: laneItems.map((t) => `${todoGlyph(t.status)} ${t.text}`),
		};
	});
	const gutters = (cols.length - 1) * COL_SEP.length;
	// Cap: even terminal split — the old fixed width, now an upper bound.
	const cap = Math.max(MIN_COL_WIDTH, Math.floor((termW() - gutters) / cols.length));
	// Compact: shrink each column to its widest cell, but never past the cap.
	const widths = cols.map((c) =>
		Math.min(cap, Math.max(c.header.length, ...c.cards.map((s) => s.length))),
	);
	const rowCount = Math.max(...cols.map((c) => c.items.length));
	const sep = theme.fg("muted", COL_SEP);

	const headerRow = cols
		.map((c, i) => theme.fg(TODO_COLOR[c.status], cell(c.header, widths[i] ?? 0)))
		.join(sep);

	const rows: string[] = [];
	for (let r = 0; r < rowCount; r++) {
		const row = cols
			.map((c, i) => {
				const w = widths[i] ?? 0;
				const t = c.items[r];
				if (!t) return " ".repeat(w);
				const padded = cell(c.cards[r] ?? "", w);
				// Card body shares its status color (matches the glyph); the in-flight
				// card is also bolded so the eye lands on it first.
				return t.status === "in_progress"
					? theme.bold(theme.fg("accent", padded))
					: theme.fg(TODO_COLOR[t.status], padded);
			})
			.join(sep);
		rows.push(row);
	}

	return [headerRow, ...rows].join("\n");
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
		// Whether the current list is a sequential run. Ordered lists cascade-close
		// earlier items and warn on out-of-order completion; unordered lists treat
		// every item as independent. Default true — plans are usually sequential.
		let ordered = true;

		// Single-open policy: only the newest todo card stays expanded. When a new
		// card first renders (its state bag is unseen), collapse the previously
		// focused card so two boards are never open at once. A card that is itself
		// already collapsed never steals focus, so the invalidate re-render it
		// triggers can't ping-pong.
		let focused: { state: CollapseState; invalidate: () => void } | undefined;
		function focusCard(state: CollapseState, invalidate: () => void) {
			if (focused?.state === state) return; // already the focused card
			const prev = focused;
			focused = { state, invalidate };
			if (prev && !prev.state.collapsed) {
				if (prev.state.timer) {
					clearTimeout(prev.state.timer);
					prev.state.timer = undefined;
				}
				prev.state.collapsed = true;
				prev.invalidate();
			}
		}

		function persistTodos() {
			pi.appendEntry("todo-state", { todos, nextTodoId, ordered });
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
				"If the list is NOT a sequential run (items independent, done in any order), pass `ordered:false` on `set` — that disables the cascade-close and skip warning.",
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
				ordered: Type.Optional(
					Type.Boolean({
						description:
							"For set: true (default) = sequential run (opening/completing an item cascades to earlier ones and warns on skips); false = independent items done in any order.",
					}),
				),
			}),
			// Show the `todo <action>` title like other tool calls. Hidden once the
			// card collapses — the collapsed summary row already carries the title.
			renderCall(args, theme, context) {
				const state = context.state as CollapseState;
				if (state?.collapsed && !context.expanded) return new Text("", 0, 0);
				const t = theme as TodoTheme;
				const action = (args as { action?: string })?.action ?? "";
				const title = t.fg("toolTitle", t.bold("todo"));
				return new Text(action ? `${title} ${t.fg("dim", action)}` : title, 0, 0);
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
				// An open card claims focus, collapsing any earlier open board.
				if (!collapsed) focusCard(context.state as CollapseState, context.invalidate);
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
						ordered = (params.ordered as boolean | undefined) ?? true;
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
							// Sequential-progress invariant (ordered lists only): opening a task
							// means everything before it is finished. Cascade-close every earlier
							// pending or in_progress item so the model never has to mark skipped
							// steps done by hand. `blocked` is left untouched. Unordered lists
							// treat each item independently — no cascade, no skip warning.
							if (ordered && params.status === "in_progress")
								for (const other of todos)
									if (
										other.id < t.id &&
										(other.status === "pending" || other.status === "in_progress")
									)
										other.status = "done";

							if (ordered && params.status === "done") skipWarning = buildSkipWarning(todos, t.id);

							t.status = params.status;
						}
						if (params.text) t.text = params.text;
						persistTodos();
						return ok(todoSummary() + skipWarning);
					}

					case "clear":
						todos = [];
						nextTodoId = 1;
						ordered = true;
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
				data?: { todos?: TodoItem[]; nextTodoId?: number; ordered?: boolean };
			}>;
			const lastTodo = entries
				.filter((e) => e.type === "custom" && e.customType === "todo-state")
				.pop();
			if (Array.isArray(lastTodo?.data?.todos)) {
				todos = lastTodo.data.todos;
				nextTodoId = lastTodo.data.nextTodoId ?? todos.reduce((m, t) => Math.max(m, t.id + 1), 1);
				ordered = lastTodo.data.ordered ?? true;
			}
		});
	});
}
