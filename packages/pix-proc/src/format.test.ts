import { describe, expect, test } from "bun:test";
import {
	completeLines,
	humanUptime,
	logSince,
	MAX_LOG_LINES,
	type ProcMeta,
	procLabel,
	statusLine,
	statusWord,
	tailLines,
} from "./format.ts";

describe("completeLines", () => {
	test("drops a trailing partial line and reports the newline offset", () => {
		const { lines, offset } = completeLines("a\nb\npartial");
		expect(lines).toEqual(["a", "b"]);
		expect(offset).toBe("a\nb\n".length); // cursor sits after the last newline
	});

	test("no newline yet → no complete lines, cursor stays at 0", () => {
		expect(completeLines("still typing")).toEqual({ lines: [], offset: 0 });
	});
});

describe("logSince cursor", () => {
	test("first read returns all complete lines and advances the cursor", () => {
		const text = "one\ntwo\nthree\n";
		const v = logSince(text, 0);
		expect(v.lines).toEqual(["one", "two", "three"]);
		expect(v.offset).toBe(text.length);
		expect(v.more).toBe(0);
	});

	test("second read from the stored cursor returns only new lines", () => {
		const first = "one\ntwo\n";
		const v1 = logSince(first, 0);
		const grown = `${first}three\nfour\n`;
		const v2 = logSince(grown, v1.offset);
		expect(v2.lines).toEqual(["three", "four"]);
	});

	test("a partial trailing line is not returned and does not advance past it", () => {
		const v = logSince("done\nhalf", 0);
		expect(v.lines).toEqual(["done"]);
		expect(v.offset).toBe("done\n".length);
	});

	test("clamps to MAX_LOG_LINES keeping the newest, reports the overflow", () => {
		const n = MAX_LOG_LINES + 5;
		const text = `${Array.from({ length: n }, (_, i) => `L${i}`).join("\n")}\n`;
		const v = logSince(text, 0);
		expect(v.lines).toHaveLength(MAX_LOG_LINES);
		expect(v.lines.at(-1)).toBe(`L${n - 1}`);
		expect(v.more).toBe(5);
	});
});

describe("tailLines", () => {
	const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
	test("returns the last n", () => {
		expect(tailLines(lines, 3)).toEqual(["L17", "L18", "L19"]);
	});
	test("clamps n to [1, MAX_LOG_LINES]", () => {
		expect(tailLines(lines, 0)).toEqual(["L19"]);
		expect(tailLines(lines, 5000)).toHaveLength(20);
	});
});

describe("statusWord / statusLine", () => {
	const base: ProcMeta = {
		handle: "proc-swift-otter-42",
		command: "npm run dev",
		cwd: "/x",
		pid: 100,
		pgid: 100,
		startTime: 0,
		status: "running",
		capped: false,
	};

	test("statusWord reflects lifecycle", () => {
		expect(statusWord(base)).toBe("running");
		expect(statusWord({ ...base, status: "killed" })).toBe("killed");
		expect(statusWord({ ...base, status: "exited", exitCode: 1 })).toBe("exited(1)");
	});

	test("statusLine has handle, command, uptime, status in order", () => {
		const line = statusLine(base, 134_000, "Local: http://localhost:5173");
		expect(line).toMatch(
			/^proc-swift-otter-42 · npm run dev · 2m14s · running · Local: http:\/\/localhost:5173$/,
		);
	});

	test("capped flag appears when set", () => {
		expect(statusLine({ ...base, capped: true }, 1000)).toContain(" · capped");
	});
});

describe("procLabel", () => {
	test("heredoc command → first line only, ends with ' …'", () => {
		const label = procLabel({ command: "python -u - <<'PY'\nimport os\nprint(1)\nPY" });
		expect(label).toMatch(/^python -u - <<'PY' …$/);
	});

	test("masks secret-looking env values, keeps other assignments", () => {
		const label = procLabel({
			name: "cam",
			command: "CAMERA_TEST_PASSWORD='p w' API_KEY=abc PORT=3000 node x.js",
		});
		expect(label).toBe("cam (CAMERA_TEST_PASSWORD=*** API_KEY=*** PORT=3000 node x.js)");
	});
});

describe("humanUptime", () => {
	test("seconds, minutes, hours forms", () => {
		expect(humanUptime(9_000)).toBe("9s");
		expect(humanUptime(134_000)).toBe("2m14s");
		expect(humanUptime(3_780_000)).toBe("1h03m");
	});
});
