import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { cacheRatio, collectMetrics, parseJsonl } from "./metrics.ts";
import { FIXTURE, TASKS } from "./tasks.ts";

const assistant = (text: string, usage: object) =>
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			provider: "p",
			model: "m",
			content: [{ type: "text", text }],
			usage,
		},
	});

describe("collectMetrics", () => {
	test("sums usage per assistant message and counts tool calls and edit failures", () => {
		const stream = [
			JSON.stringify({ type: "session", id: "x" }),
			assistant("", { input: 100, output: 10, cacheRead: 50, cost: { total: 0.01 } }),
			JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: false }),
			JSON.stringify({
				type: "tool_execution_end",
				toolName: "edit",
				isError: true,
				result: {
					content: [{ type: "text", text: "Stale anchor: 3#ABC. Use the current anchors" }],
				},
			}),
			"not json",
			assistant("done\u2028ok", { input: 20, output: 5, cacheRead: 150, cost: { total: 0.02 } }),
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", stopReason: "error", content: [], usage: {} },
			}),
		].join("\n");
		const m = collectMetrics(parseJsonl(stream));
		expect(m).toMatchObject({
			model: "p/m",
			turns: 3,
			providerErrors: 1,
			input: 120,
			output: 15,
			cacheRead: 200,
			toolCalls: 2,
			byTool: { read: 1, edit: 1 },
			toolErrors: 1,
			editFailed: 1,
			editStale: 1,
			finalText: "done\u2028ok",
		});
		expect(m.cost).toBeCloseTo(0.03, 6);
		expect(cacheRatio(m)).toBeCloseTo(200 / 320, 6);
		expect(m.runaway).toBe(false);
	});

	test("flags a stream that ends inside a whitespace-only tool call", () => {
		const delta = (d: string) =>
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_delta", delta: d },
			});
		const start = JSON.stringify({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_start" },
		});
		const stuck = [start, delta('{"path":"a"'), ...Array(300).fill(delta(" \t \t"))].join("\n");
		expect(collectMetrics(parseJsonl(stuck)).runaway).toBe(true);
		const ended = [
			start,
			delta(" ".repeat(2000)),
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_end" } }),
		].join("\n");
		expect(collectMetrics(parseJsonl(ended)).runaway).toBe(false);
	});
});

describe("eval fixture", () => {
	const write = (dir: string, files: Record<string, string>) => {
		for (const [rel, text] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, rel)), { recursive: true });
			writeFileSync(join(dir, rel), text);
		}
	};
	const bunTest = async (dir: string) =>
		(await Bun.spawn([process.execPath, "test"], { cwd: dir, stdout: "ignore", stderr: "ignore" })
			.exited) === 0;

	test("task ids are unique", () => {
		expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
	});

	test("no task passes on the untouched fixture with an empty answer", async () => {
		for (const task of TASKS) {
			const dir = mkdtempSync(join(tempDir(), "pix-eval-test-"));
			try {
				write(dir, { ...FIXTURE, ...task.files });
				const pass = await task.check({ dir, finalText: "", testsPass: () => bunTest(dir) });
				expect({ task: task.id, pass }).toEqual({ task: task.id, pass: false });
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	}, 60_000);

	test("reference fixes pass their checks", async () => {
		const fixes: Record<string, { files?: Record<string, string>; answer?: string }> = {
			"read-config": { answer: "4" },
			"search-def": { answer: "src/duration.ts" },
			"search-importers": { answer: "2" },
			"read-catalog-row": { answer: String((316 * 37) % 997) },
			"fix-clamp": { files: { "src/math.ts": FIXTURE["src/math.ts"] ?? "" } },
			"edit-catalog-row": {
				files: {
					"src/catalog.ts":
						FIXTURE["src/catalog.ts"]?.replace(/(sku: "SKU-0350", price: )\d+/, "$11234") ?? "",
				},
			},
		};
		for (const [id, fix] of Object.entries(fixes)) {
			const task = TASKS.find((t) => t.id === id);
			if (!task) throw new Error(`missing task ${id}`);
			const dir = mkdtempSync(join(tempDir(), "pix-eval-test-"));
			try {
				write(dir, { ...FIXTURE, ...task.files, ...fix.files });
				const pass = await task.check({
					dir,
					finalText: fix.answer ?? "",
					testsPass: () => bunTest(dir),
				});
				expect({ id, pass }).toEqual({ id, pass: true });
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	}, 60_000);
});
