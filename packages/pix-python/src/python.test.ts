import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capturePi, makeRenderCtx, makeTheme } from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { setUnattendedMode } from "@xynogen/pix-runtime";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import { normalizeCode, resolvePython } from "./lib.ts";

describe("normalizeCode", () => {
	test("dedents, expands tabs, drops fences, CRLF and edge blank lines", () => {
		const raw = "```python\r\n    def f():\r\n    \treturn 1\r\n\r\n    print(f())\r\n```";
		expect(normalizeCode(raw)).toBe("def f():\n    return 1\n\nprint(f())");
	});

	test("leaves already-clean code alone", () => {
		const code = "import json\nfor i in range(2):\n    print(i)";
		expect(normalizeCode(code)).toBe(code);
	});
});

describe("resolvePython", () => {
	const root = mkdtempSync(join(tempDir(), "pix-python-"));
	const touch = (p: string) => {
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, "");
	};
	touch(join(root, ".venv", "bin", "python3"));
	touch(join(root, "winenv", "Scripts", "python.exe"));

	test("omitted → catalog python3; bare name → PATH lookup", () => {
		expect(resolvePython(undefined, root)).toBe("python3");
		expect(resolvePython("  ", root)).toBe("python3");
		expect(resolvePython("python3.12", root)).toBe("python3.12");
	});

	test("venv folder → its interpreter (POSIX and Windows layouts), relative to cwd", () => {
		expect(resolvePython(".venv", root, false)).toBe(join(root, ".venv", "bin", "python3"));
		expect(resolvePython(join(root, "winenv"), "/", true)).toBe(
			join(root, "winenv", "Scripts", "python.exe"),
		);
	});

	test("interpreter file path is used as is", () => {
		expect(resolvePython(".venv/bin/python3", root)).toBe(join(root, ".venv", "bin", "python3"));
	});

	test("missing path or folder without an interpreter throws a clear error", () => {
		expect(() => resolvePython("./nope", root)).toThrow(/python path not found: .*nope/);
		expect(() => resolvePython("winenv", root, false)).toThrow(/no Python interpreter in .*winenv/);
	});
});

const runPython = mock(async () => ({ code: 0, stdout: "42\n", stderr: "", timedOut: false }));
const lib = await import("./lib.ts");
mock.module("./lib.ts", () => ({ ...lib, runPython }));
const { default: register } = await import("./index.ts");

function host() {
	const events = createEventBus();
	const { pi, tool } = capturePi();
	register({ ...pi, events } as unknown as ExtensionAPI);
	const execute = tool.execute as (
		...a: unknown[]
	) => Promise<ToolResultLike & { isError?: boolean }>;
	return { tool, events, execute };
}

const args = { intent: "Add numbers", code: "\tprint(40 + 2)" };
const getText = (r: ToolResultLike) =>
	(r.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");

describe("python_run", () => {
	test("nuclear runs without approval UI", async () => {
		const { execute, events } = host();
		setUnattendedMode(events, "nuclear");
		const result = await execute("n", args, undefined, undefined, { hasUI: false, cwd: "/work" });
		expect(result.details).toMatchObject({ outcome: "success" });
	});
	test.each([true, false])("ordinary code runs without approval (hasUI=%s)", async (hasUI) => {
		const { tool, execute, events } = host();
		const custom = mock(() => {
			throw new Error("unexpected approval");
		});
		const states: string[] = [];
		events.on("pix:agent-state", (raw) => states.push((raw as { state: string }).state));
		const result = await execute("t", args, undefined, undefined, {
			hasUI,
			ui: { custom },
			cwd: "/work",
		});
		expect(result.details).toMatchObject({ outcome: "success", stdout: "42" });
		expect(custom).not.toHaveBeenCalled();
		expect(states).toEqual([]);
		expect(runPython).toHaveBeenLastCalledWith(
			"print(40 + 2)",
			"/work",
			undefined,
			"python3",
			undefined,
			expect.any(Function),
		);
		const component = tool.renderCall?.(args, makeTheme(), makeRenderCtx({ expanded: true }));
		expect(component?.render(100).join("\n")).toContain("print(40 + 2)");
	});

	test("AFK does not block ordinary Python", async () => {
		const { execute, events } = host();
		setUnattendedMode(events, "afk");
		const result = await execute("afk", args, undefined, undefined, { hasUI: false, cwd: "/work" });
		expect(result.details).toMatchObject({ outcome: "success" });
	});

	test("resolves the interpreter and rejects missing paths before running", async () => {
		const root = mkdtempSync(join(tempDir(), "pix-python-run-"));
		mkdirSync(join(root, ".venv", "bin"), { recursive: true });
		writeFileSync(join(root, ".venv", "bin", "python3"), "");
		const { execute } = host();
		const ctx = { hasUI: false, cwd: root };
		const venvPy = process.platform === "win32" ? undefined : join(root, ".venv", "bin", "python3");
		if (venvPy) {
			const r = await execute("t", { ...args, python: ".venv" }, undefined, undefined, ctx);
			expect(runPython).toHaveBeenLastCalledWith(
				"print(40 + 2)",
				root,
				undefined,
				venvPy,
				undefined,
				expect.any(Function),
			);
			expect(r.details).toMatchObject({ python: ".venv", outcome: "success" });
		}
		runPython.mockClear();
		const bad = await execute("t", { ...args, python: "./missing-env" }, undefined, undefined, {
			...ctx,
		});
		expect(bad.isError).toBe(true);
		expect(getText(bad)).toMatch(/python path not found/);
		expect(runPython).not.toHaveBeenCalled();
	});

	test("empty code never starts Python", async () => {
		runPython.mockClear();
		const result = await host().execute("empty", { ...args, code: " " }, undefined, undefined, {
			hasUI: false,
			cwd: "/work",
		});
		expect(result.isError).toBe(true);
		expect(getText(result)).toContain("empty code");
		expect(runPython).not.toHaveBeenCalled();
	});

	test("result: stdout, stderr in status color, status line, framed close", async () => {
		const fixture = await withUiFixture();
		try {
			const { tool } = host();
			const render = (outcome: string, exitCode: number, stderr = "", expanded = false) => {
				const isError = exitCode !== 0;
				const component = tool.renderResult?.(
					{
						content: [{ type: "text", text: "" }],
						details: {
							_type: "pythonResult",
							intent: "i",
							code: "c",
							outcome,
							exitCode,
							durationMs: 120,
							interpreter: "/p/.venv/bin/python3",
							stdout: "out",
							stderr,
						},
					},
					{ isPartial: false },
					roleTheme(),
					makeRenderCtx({ isError, isPartial: false, expanded }),
				);
				if (!component) throw new Error("missing renderer");
				return captureRows(component, { width: 80, surface: "host-self" });
			};
			const ok = render("success", 0);
			expect(ok.some((r) => r.trim() === "out")).toBe(true);
			// Status row: glyph in the status role, then muted `exit · time · interpreter`.
			expect(ok.at(-2)).toMatch(
				/^\s+<success>.+<\/success> <muted>exit 0 · \d+ms · \/p\/\.venv\/bin\/python3<\/muted>\s*$/,
			);
			expect(ok.at(-1)).toBe(`<success>${"─".repeat(80)}</success>`);

			const bad = render("error", 1, "Traceback\nZeroDivisionError: division by zero");
			expect(bad).toContainEqual(
				expect.stringMatching(/<error>ZeroDivisionError: division by zero<\/error>/),
			);
			expect(bad.at(-2)).toMatch(/<error>.+<\/error> <muted>exit 1/);
			expect(bad.at(-1)).toBe(`<error>${"─".repeat(80)}</error>`);

			// Success with stderr (warnings) uses the warning role, not error.
			expect(render("success", 0, "DeprecationWarning: x")).toContainEqual(
				expect.stringMatching(/<warning>DeprecationWarning: x<\/warning>/),
			);
		} finally {
			await fixture.restore();
		}
	});

	test("while args stream: one stable header row, no code viewer", async () => {
		const fixture = await withUiFixture();
		try {
			const { tool } = host();
			const component = tool.renderCall?.({ intent: "Add", code: "x = 1\nprint(" }, roleTheme(), {
				...makeRenderCtx({ isPartial: true }),
				argsComplete: false,
			});
			if (!component) throw new Error("missing renderer");
			const rows = captureRows(component, { width: 80, surface: "component" });
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatch(/python.*· writing 2 lines…/);
		} finally {
			await fixture.restore();
		}
	});

	test("call card shows the script in the pix-pretty code viewer, numbered like the traceback", async () => {
		const fixture = await withUiFixture();
		try {
			const { tool } = host();
			const rc = makeRenderCtx({ isPartial: true });
			let invalidated!: () => void;
			const ready = new Promise<void>((r) => {
				invalidated = r;
			});
			const component = tool.renderCall?.(
				{ intent: "Add", code: "```python\n\tx = 1\n\tprint(x)\n```" },
				roleTheme(),
				{ ...rc, invalidate: () => invalidated() },
			);
			if (!component) throw new Error("missing renderer");
			captureRows(component, { width: 80, surface: "component" }); // starts the async render
			await ready;
			const rows = captureRows(component, { width: 80, surface: "component" });
			expect(rows[0]).toMatch(/<toolTitle[^>]*>python<\/toolTitle[^>]*>$/);
			// Viewer shape: rule, numbered rows of the exact script, rule.
			const plain = rows.slice(1).map((r) => r.replace(/<\/?[\w.+]+>/g, "").trimEnd());
			expect(plain).toEqual([
				expect.stringMatching(/^─{80}$/),
				"  1 │ x = 1",
				"  2 │ print(x)",
				expect.stringMatching(/^─{80}$/),
			]);
		} finally {
			await fixture.restore();
		}
	});
});

test("pre-cancelled calls never start Python", async () => {
	const { execute } = host();
	const before = runPython.mock.calls.length;
	const result = await execute("cancel", args, AbortSignal.abort(new Error("stop")), undefined, {
		hasUI: false,
		cwd: "/work",
	});
	expect(result.details).toMatchObject({ outcome: "cancelled" });
	expect(result.isError).toBe(false);
	expect(runPython.mock.calls.length).toBe(before);
});
