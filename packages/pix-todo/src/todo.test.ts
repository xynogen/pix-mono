import { beforeEach, describe, expect, test } from "bun:test";
import registerTodo, { renderTodoLines, renderTodoSummaryLine, type TodoItem } from "./todo.ts";

// registerTodo wraps its body in once(pi, "pix-todo") — a per-instance
// WeakMap guard that dedupes activation across pix-core + a standalone install.
// Tests re-register a fresh host per case. Clear the registry between tests so
// that the same pi object can be re-used without cross-test interference.
beforeEach(() => {
	delete (globalThis as { __pixOnce?: WeakMap<object, Set<string>> }).__pixOnce;
});

// Stub theme tags each fragment with its color/bold so assertions can verify
// which status got which tint, without depending on real ANSI codes.
const tagTheme = {
	fg: (color: string, text: string) => `[${color}]${text}[/]`,
	bold: (text: string) => `<b>${text}</b>`,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a mock ExtensionAPI that captures the registered tool's execute fn. */
function makeHost(
	initialEntries: Array<{
		type: string;
		customType?: string;
		data?: unknown;
	}> = [],
) {
	let capturedParameters: unknown;
	let capturedRenderShell: unknown;
	let capturedExecute:
		| ((
				id: string,
				params: Record<string, unknown>,
		  ) => Promise<{
				content: Array<{ type: string; text: string }>;
				details?: unknown;
				isError?: boolean;
		  }>)
		| null = null;
	const appendCalls: Array<{ type: string; data: unknown }> = [];
	const handlers: Record<string, Array<(event: unknown, ctx?: unknown) => unknown>> = {};

	let capturedRender:
		| ((
				result: unknown,
				options: unknown,
				theme: unknown,
				context: unknown,
		  ) => { render(width: number): string[] })
		| null = null;
	let capturedRenderCall:
		| ((args: unknown, theme: unknown, context: unknown) => { render(width: number): string[] })
		| null = null;

	const pi = {
		registerTool(def: {
			name: string;
			parameters: unknown;
			execute: typeof capturedExecute;
			renderShell?: unknown;
			renderCall?: typeof capturedRenderCall;
			renderResult?: typeof capturedRender;
		}) {
			capturedParameters = def.parameters;
			capturedRenderShell = def.renderShell;
			capturedExecute = def.execute;
			if (def.renderCall) capturedRenderCall = def.renderCall;
			if (def.renderResult) capturedRender = def.renderResult;
		},
		appendEntry(type: string, data: unknown) {
			appendCalls.push({ type, data });
		},
		on(ev: string, fn: (event: unknown, ctx?: unknown) => unknown) {
			if (!handlers[ev]) handlers[ev] = [];
			handlers[ev].push(fn);
		},
		async emit(ev: string, event?: unknown, ctx?: unknown): Promise<unknown> {
			let last: unknown;
			for (const fn of handlers[ev] ?? []) {
				const result = await fn(event, ctx);
				if (result !== undefined) last = result;
			}
			return last;
		},
	} as never;

	const sessionManager = {
		getEntries() {
			return initialEntries;
		},
	};

	return {
		pi,
		sessionManager,
		get parameters() {
			if (!capturedParameters) throw new Error("parameters not captured");
			return capturedParameters;
		},
		get execute() {
			if (!capturedExecute) throw new Error("execute not captured");
			return capturedExecute;
		},
		get renderShell() {
			return capturedRenderShell;
		},
		get renderCall() {
			if (!capturedRenderCall) throw new Error("renderCall not captured");
			return capturedRenderCall;
		},
		get render() {
			if (!capturedRender) throw new Error("render not captured");
			return capturedRender;
		},
		appendCalls,
		async emit(ev: string, event?: unknown, ctx?: unknown): Promise<unknown> {
			let last: unknown;
			for (const fn of handlers[ev] ?? []) {
				const result = await fn(event, ctx);
				if (result !== undefined) last = result;
			}
			return last;
		},
	};
}

async function run(
	execute: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: unknown;
		isError?: boolean;
	}>,
	params: Record<string, unknown>,
) {
	return execute("call-1", params);
}

function text(result: { content: Array<{ type: string; text: string }> }) {
	return result.content.map((c) => c.text).join("\n");
}

// ─── Tool schema ────────────────────────────────────────────────────────────

test("todo exposes action and status as guided string enums", () => {
	const host = makeHost();
	registerTodo(host.pi);
	const schema = host.parameters as {
		properties: {
			action: { type?: string; enum?: string[]; description?: string };
			status: { type?: string; enum?: string[]; description?: string };
		};
	};
	const action = schema.properties.action;
	const status = schema.properties.status;

	expect(action.type).toBe("string");
	expect(action.enum).toEqual(["list", "set", "add", "update", "clear"]);
	expect(action.description).toContain('"list" shows items');
	expect(action.description).toContain('"update" changes one item by id');
	expect(status?.type).toBe("string");
	expect(status?.enum).toEqual(["pending", "in_progress", "done", "blocked"]);
	expect(status?.description).toContain('"pending" = not started');
	expect(status?.description).toContain('"blocked" = cannot proceed');
});

// ─── parseItems (via set/add) ───────────────────────────────────────────────

describe("todo actions", () => {
	test("list on empty returns (no todos)", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "list" });
		expect(text(result)).toBe("(no todos)");
	});

	test("set creates items from newline text", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, {
			action: "set",
			items: "alpha\nbravo\ncharlie",
		});
		const out = text(result);
		expect(out).toContain("Todos 0/3 done");
		expect(out).toContain("○ 1. alpha");
		expect(out).toContain("○ 2. bravo");
		expect(out).toContain("○ 3. charlie");
	});

	test("set creates items from numbered list", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, {
			action: "set",
			items: "1. alpha\n2. bravo",
		});
		expect(text(result)).toContain("○ 1. alpha");
	});

	test("set creates items from bullet list", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, {
			action: "set",
			items: "- alpha\n* bravo",
		});
		expect(text(result)).toContain("○ 1. alpha");
		expect(text(result)).toContain("○ 2. bravo");
	});

	test("set ignores empty lines", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, {
			action: "set",
			items: "alpha\n\nbravo\n  \ncharlie",
		});
		expect(text(result)).toContain("Todos 0/3 done");
	});

	test("set with empty items returns error", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "set", items: "" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("non-empty");
	});

	test("set with only whitespace returns error", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "set", items: "  \n  " });
		expect(result.isError).toBe(true);
	});

	test("set resets ids on re-set", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "first\nsecond" });
		const result = await run(host.execute, { action: "set", items: "new" });
		expect(text(result)).toContain("○ 1. new");
		expect(text(result)).toContain("Todos 0/1 done");
	});

	test("add appends items", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "alpha" });
		const result = await run(host.execute, {
			action: "add",
			items: "bravo\ncharlie",
		});
		const out = text(result);
		expect(out).toContain("○ 1. alpha");
		expect(out).toContain("○ 2. bravo");
		expect(out).toContain("○ 3. charlie");
		expect(out).toContain("Todos 0/3 done");
	});

	test("add with ids continuing sequence", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "first\nsecond\nthird" });
		const result = await run(host.execute, { action: "add", items: "fourth" });
		expect(text(result)).toContain("○ 4. fourth");
	});

	test("add with empty items returns error", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "add", items: "" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("non-empty");
	});

	test("update changes status", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "alpha\nbravo" });
		const result = await run(host.execute, {
			action: "update",
			id: 1,
			status: "done",
		});
		const out = text(result);
		expect(out).toContain("● 1. alpha");
		expect(out).toContain("○ 2. bravo");
		expect(out).toContain("Todos 1/2 done");
	});

	test("update changes text", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "old name" });
		const result = await run(host.execute, {
			action: "update",
			id: 1,
			text: "new name",
		});
		expect(text(result)).toContain("○ 1. new name");
	});

	test("update changes status and text together", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "alpha" });
		const result = await run(host.execute, {
			action: "update",
			id: 1,
			status: "blocked",
			text: "alpha (waiting)",
		});
		const out = text(result);
		expect(out).toContain("⊘ 1. alpha (waiting)");
		expect(out).toContain("Todos 0/1 done");
	});

	test("opening a new in_progress closes the previous one", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "a\nb\nc" });
		await run(host.execute, { action: "update", id: 1, status: "in_progress" });
		const result = await run(host.execute, {
			action: "update",
			id: 2,
			status: "in_progress",
		});
		const out = text(result);
		expect(out).toContain("● 1. a"); // auto-closed to done
		expect(out).toContain("◐ 2. b"); // now active
		expect(out).toContain("○ 3. c");
		expect(out).toContain("Todos 1/3 done");
	});

	test("opening a later item cascade-closes skipped pending items", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "a\nb\nc\nd" });
		// Jump straight to id 4 without opening 1-3; they should all auto-close.
		const result = await run(host.execute, {
			action: "update",
			id: 4,
			status: "in_progress",
		});
		const out = text(result);
		expect(out).toContain("● 1. a");
		expect(out).toContain("● 2. b");
		expect(out).toContain("● 3. c");
		expect(out).toContain("◐ 4. d");
		expect(out).toContain("Todos 3/4 done");
	});

	test("cascade-close leaves a blocked earlier item untouched", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "a\nb\nc" });
		await run(host.execute, { action: "update", id: 1, status: "blocked" });
		const result = await run(host.execute, {
			action: "update",
			id: 3,
			status: "in_progress",
		});
		const out = text(result);
		expect(out).toContain("⊘ 1. a"); // still blocked, not force-closed
		expect(out).toContain("● 2. b"); // pending -> done
		expect(out).toContain("◐ 3. c");
	});

	test("update unknown id returns error", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, {
			action: "update",
			id: 999,
			status: "done",
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("999");
	});

	test("update without status or text does nothing", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "unchanged" });
		const result = await run(host.execute, { action: "update", id: 1 });
		expect(text(result)).toContain("○ 1. unchanged");
	});

	test("clear empties list", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "alpha\nbravo" });
		const result = await run(host.execute, { action: "clear" });
		expect(text(result)).toContain("Todos cleared");
		// next list should show empty
		const list = await run(host.execute, { action: "list" });
		expect(text(list)).toBe("(no todos)");
	});

	test("clear resets id counter", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "alpha\nbravo\ncharlie" });
		await run(host.execute, { action: "clear" });
		const result = await run(host.execute, { action: "set", items: "new" });
		expect(text(result)).toContain("○ 1. new");
	});

	test("unknown action returns error", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "bogus" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Unknown action");
	});

	test("all status glyphs render correctly", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "a\nb\nc\nd" });
		// Open id 2 first (cascade-closes nothing earlier we assert on), then set
		// the others directly so each glyph is exercised without cascade interfering.
		await run(host.execute, { action: "update", id: 2, status: "in_progress" });
		await run(host.execute, { action: "update", id: 1, status: "pending" });
		await run(host.execute, { action: "update", id: 3, status: "done" });
		await run(host.execute, { action: "update", id: 4, status: "blocked" });
		const out = text(await run(host.execute, { action: "list" }));
		expect(out).toContain("○ 1. a");
		expect(out).toContain("◐ 2. b");
		expect(out).toContain("● 3. c");
		expect(out).toContain("⊘ 4. d");
		expect(out).toContain("Todos 1/4 done");
	});
});

// ─── Persistence ────────────────────────────────────────────────────────────

describe("persistence", () => {
	type AppendCall = { type: string; data: unknown };
	test("set persists todos", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		host.appendCalls.length = 0;
		await run(host.execute, { action: "set", items: "alpha\nbravo" });
		expect(host.appendCalls.length).toBe(1);
		const ac0 = host.appendCalls[0] as AppendCall;
		expect(ac0.type).toBe("todo-state");
		const data = ac0.data as {
			todos: Array<{ id: number; text: string; status: string }>;
			nextTodoId: number;
		};
		expect(data.todos).toHaveLength(2);
		expect(data.nextTodoId).toBe(3);
	});

	test("add persists todos", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "alpha" });
		host.appendCalls.length = 0;
		await run(host.execute, { action: "add", items: "bravo" });
		expect(host.appendCalls.length).toBe(1);
	});

	test("update persists todos", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "alpha" });
		host.appendCalls.length = 0;
		await run(host.execute, { action: "update", id: 1, status: "done" });
		expect(host.appendCalls.length).toBe(1);
	});

	test("clear persists", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "alpha" });
		host.appendCalls.length = 0;
		await run(host.execute, { action: "clear" });
		expect(host.appendCalls.length).toBe(1);
		const data = (host.appendCalls[0] as AppendCall).data as {
			todos: Array<unknown>;
			nextTodoId: number;
		};
		expect(data.todos).toEqual([]);
		expect(data.nextTodoId).toBe(1);
	});
});

// ─── Session restore ────────────────────────────────────────────────────────

describe("restore", () => {
	test("restores todos from last todo-state entry", async () => {
		const host = makeHost([
			{
				type: "custom",
				customType: "todo-state",
				data: {
					todos: [{ id: 1, text: "restored", status: "done" }],
					nextTodoId: 2,
				},
			},
		]);
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "list" });
		expect(text(result)).toContain("● 1. restored");
		expect(text(result)).toContain("Todos 1/1 done");
	});

	test("restores nextTodoId so new items continue sequence", async () => {
		const host = makeHost([
			{
				type: "custom",
				customType: "todo-state",
				data: {
					todos: [{ id: 5, text: "existing", status: "pending" }],
					nextTodoId: 6,
				},
			},
		]);
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "add", items: "new" });
		expect(text(result)).toContain("○ 6. new");
	});

	test("restores nextTodoId from max id when nextTodoId missing", async () => {
		const host = makeHost([
			{
				type: "custom",
				customType: "todo-state",
				data: {
					todos: [
						{ id: 3, text: "old", status: "done" },
						{ id: 7, text: "newer", status: "pending" },
					],
				},
			},
		]);
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "add", items: "next" });
		expect(text(result)).toContain("○ 8. next");
	});

	test("ignores non-todo-state entries", async () => {
		const host = makeHost([
			{ type: "message", data: "hello" },
			{ type: "custom", customType: "other-thing", data: {} },
			{
				type: "custom",
				customType: "todo-state",
				data: {
					todos: [{ id: 1, text: "real", status: "pending" }],
					nextTodoId: 2,
				},
			},
		]);
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "list" });
		expect(text(result)).toContain("○ 1. real");
	});

	test("no todo-state entries starts empty", async () => {
		const host = makeHost([{ type: "message", data: "hello" }]);
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "list" });
		expect(text(result)).toBe("(no todos)");
	});

	test("empty entries list starts empty", async () => {
		const host = makeHost([]);
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "list" });
		expect(text(result)).toBe("(no todos)");
	});

	test("restore with empty todos array works", async () => {
		const host = makeHost([
			{
				type: "custom",
				customType: "todo-state",
				data: { todos: [], nextTodoId: 1 },
			},
		]);
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "list" });
		expect(text(result)).toBe("(no todos)");
	});
});

// ─── Skip-guard ─────────────────────────────────────────────────────────────────────

describe("skip-guard on marking done", () => {
	test("warns when marking a later item done with earlier pending items", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "a\nb\nc\nd" });
		// Mark items 1 and 4 done, leaving 2 and 3 pending
		await run(host.execute, { action: "update", id: 1, status: "done" });
		const result = await run(host.execute, { action: "update", id: 4, status: "done" });
		const out = text(result);
		expect(out).toContain("\u26a0 Earlier items still incomplete");
		expect(out).toContain("#2 (b)");
		expect(out).toContain("#3 (c)");
		expect(out).toContain("Mark each done or blocked before proceeding");
	});

	test("no warning when all earlier items are done", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "a\nb\nc" });
		await run(host.execute, { action: "update", id: 1, status: "done" });
		await run(host.execute, { action: "update", id: 2, status: "done" });
		const result = await run(host.execute, { action: "update", id: 3, status: "done" });
		expect(text(result)).not.toContain("\u26a0");
	});

	test("no warning when marking the first item done", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "a\nb" });
		const result = await run(host.execute, { action: "update", id: 1, status: "done" });
		expect(text(result)).not.toContain("\u26a0");
	});

	test("no warning when earlier items are blocked (only pending/in_progress trigger)", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "a\nb\nc" });
		await run(host.execute, { action: "update", id: 1, status: "blocked" });
		await run(host.execute, { action: "update", id: 2, status: "done" });
		const result = await run(host.execute, { action: "update", id: 3, status: "done" });
		// blocked is an explicit decision, not incomplete — no warning
		expect(text(result)).not.toContain("\u26a0");
	});

	test("warns about in_progress items too (not just pending)", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "a\nb\nc" });
		await run(host.execute, { action: "update", id: 1, status: "in_progress" });
		// Mark item 3 done while item 1 is still in_progress
		const result = await run(host.execute, { action: "update", id: 3, status: "done" });
		const out = text(result);
		expect(out).toContain("\u26a0");
		expect(out).toContain("#1 (a)");
	});

	test("no skip-guard on in_progress (only on done)", async () => {
		// in_progress uses cascade-close instead, which is different behavior
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "a\nb\nc" });
		const result = await run(host.execute, { action: "update", id: 3, status: "in_progress" });
		// Should cascade-close, not warn
		expect(text(result)).not.toContain("\u26a0");
		expect(text(result)).toContain("\u25cf 1. a"); // cascade-closed to done
		expect(text(result)).toContain("\u25cf 2. b");
	});
});

// ─── Turn-based reminder ────────────────────────────────────────────────────────────

describe("turn-based todo reminder", () => {
	test("injects reminder every 10 turns when incomplete items exist", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "a\nb" });

		// Simulate 10 turns — only the 10th should inject
		for (let i = 1; i <= 9; i++) {
			const result = await host.emit("before_agent_start", { systemPrompt: "base" });
			// before_agent_start returns undefined when no injection
			expect(result).toBeUndefined();
		}
		// 10th turn should inject
		const result = await host.emit("before_agent_start", { systemPrompt: "base" });
		expect(result).toBeDefined();
		const prompt = (result as { systemPrompt: string }).systemPrompt;
		expect(prompt).toContain("base");
		expect(prompt).toContain("Todo reminder");
		expect(prompt).toContain("1. a");
		expect(prompt).toContain("2. b");
	});

	test("does not inject when no todos exist", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });

		for (let i = 1; i <= 10; i++) {
			const result = await host.emit("before_agent_start", { systemPrompt: "base" });
			expect(result).toBeUndefined();
		}
	});

	test("does not inject when all items are done", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "a" });
		await run(host.execute, { action: "update", id: 1, status: "done" });

		for (let i = 1; i <= 10; i++) {
			const result = await host.emit("before_agent_start", { systemPrompt: "base" });
			expect(result).toBeUndefined();
		}
	});
});

describe("renderTodoLines (colored TUI render)", () => {
	const items: TodoItem[] = [
		{ id: 1, text: "alpha", status: "done" },
		{ id: 2, text: "bravo", status: "in_progress" },
		{ id: 3, text: "charlie", status: "pending" },
		{ id: 4, text: "delta", status: "blocked" },
	];

	test("empty list renders muted placeholder", () => {
		expect(renderTodoLines([], tagTheme)).toBe("[muted](no todos)[/]");
	});

	test("tints each glyph by status", () => {
		const out = renderTodoLines(items, tagTheme);
		expect(out).toContain("[success]●[/]"); // done
		expect(out).toContain("[accent]◐[/]"); // in_progress
		expect(out).toContain("[muted]○[/]"); // pending
		expect(out).toContain("[error]⊘[/]"); // blocked
	});

	test("highlights the in-progress row bold + accent", () => {
		const out = renderTodoLines(items, tagTheme);
		expect(out).toContain("<b>[accent]2. bravo[/]</b>");
	});

	test("dims completed rows and uses text color for active-but-not-running", () => {
		const out = renderTodoLines(items, tagTheme);
		expect(out).toContain("[muted]1. alpha[/]"); // done body muted
		expect(out).toContain("[text]3. charlie[/]"); // pending body text
	});

	test("shows the done/total count header in blue", () => {
		const out = renderTodoLines(items, tagTheme);
		expect(out).toContain("[accent]Todos 1/4 done:[/]");
		expect(out).not.toContain("[muted]Todos 1/4 done:[/]");
	});
});

describe("todo card layout", () => {
	test("uses the self-rendered shell so the compact checkmark has no leading space", () => {
		const host = makeHost();
		registerTodo(host.pi);
		expect(host.renderShell).toBe("self");
	});

	test("keeps the call row empty so the collapsed card is one line", () => {
		const host = makeHost();
		registerTodo(host.pi);
		const call = host.renderCall({ action: "list" }, tagTheme, {});
		expect(call.render(80).join("\n")).toBe("");
	});

	test("expanded mode restores a collapsed checklist", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "set", items: "alpha\nbravo" });
		const rendered = host
			.render(result, { expanded: true }, tagTheme, {
				state: { collapsed: true },
				invalidate: () => {},
			})
			.render(80)
			.join("\n");

		expect(rendered).toContain("1. alpha");
		expect(rendered).toContain("[muted]○[/]");
		expect(rendered).not.toContain("[success]✓ [/] [toolTitle]<b>todo</b>[/]");
	});

	test("failed todo actions render their exact error", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const result = await run(host.execute, { action: "update", id: 99, status: "done" });
		const rendered = host
			.render(result, { expanded: false }, tagTheme, {
				state: { collapsed: true },
				invalidate: () => {},
			})
			.render(80)
			.join("\n")
			.trimEnd();

		expect(rendered).toBe("No todo with id 99.");
	});

	test("a collapsed result is exactly one shared-style line", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		await run(host.execute, { action: "set", items: "foundation\ntodo renderer" });
		const result = await run(host.execute, { action: "update", id: 1, status: "done" });
		const activeResult = await run(host.execute, {
			action: "update",
			id: 2,
			status: "in_progress",
		});
		const lines = host
			.render(activeResult, { expanded: false }, tagTheme, {
				state: { collapsed: true },
				invalidate: () => {},
			})
			.render(120);

		expect(result.details).toBeDefined();
		expect(lines).toHaveLength(1);
		expect(lines[0]?.trimEnd()).toBe(
			"[success]✓ [/] [toolTitle]<b>todo</b>[/] [muted]#2 todo renderer[/] [dim]·[/] [dim]1/2 done[/]",
		);
	});
});

describe("renderResult snapshot isolation", () => {
	test("successful results carry immutable snapshots", async () => {
		const host = makeHost();
		registerTodo(host.pi);
		await host.emit("session_start", {}, { sessionManager: host.sessionManager });
		const original = await run(host.execute, { action: "set", items: "alpha\nbravo" });
		await run(host.execute, { action: "set", items: "changed" });

		const details = original.details as { snapshot: TodoItem[] };
		expect(details.snapshot.map((item) => item.text)).toEqual(["alpha", "bravo"]);
		const rendered = host
			.render(original, { expanded: true }, tagTheme, {
				state: {},
				invalidate: () => {},
			})
			.render(80)
			.join("\n");
		expect(rendered).toContain("1. alpha");
		expect(rendered).toContain("2. bravo");
		expect(rendered).not.toContain("changed");
	});
});

describe("renderTodoSummaryLine (collapsed one-liner)", () => {
	test("empty list renders a compact tool row", () => {
		expect(renderTodoSummaryLine([], tagTheme)).toBe(
			"[success]✓ [/] [toolTitle]<b>todo</b>[/] [muted]empty[/]",
		);
	});

	test("uses warning status when work is blocked", () => {
		const items: TodoItem[] = [{ id: 1, text: "Need approval", status: "blocked" }];
		expect(renderTodoSummaryLine(items, tagTheme)).toBe(
			"[warning]⚠ [/] [toolTitle]<b>todo</b>[/] [muted]checklist[/] [dim]·[/] [dim]0/1 done · 1 blocked[/]",
		);
	});

	test("renders active work and progress in one row", () => {
		const items: TodoItem[] = [
			{ id: 1, text: "a", status: "done" },
			{ id: 2, text: "b", status: "in_progress" },
		];
		expect(renderTodoSummaryLine(items, tagTheme)).toBe(
			"[success]✓ [/] [toolTitle]<b>todo</b>[/] [muted]#2 b[/] [dim]·[/] [dim]1/2 done[/]",
		);
	});
});
