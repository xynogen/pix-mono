import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tempDir } from "../src/paths.ts";
import { findExecutable, findExecutableSync } from "../src/which.ts";

const isWindows = process.platform === "win32";

// A directory holding one runnable binary and one non-executable file.
function fixture(): { dir: string; binName: string } {
	const dir = mkdtempSync(join(tempDir(), "which-"));
	const binName = isWindows ? "tool.cmd" : "tool";
	const bin = join(dir, binName);
	writeFileSync(bin, isWindows ? "@echo off\n" : "#!/bin/sh\n");
	if (!isWindows) chmodSync(bin, 0o755);
	const plain = join(dir, "notexec");
	writeFileSync(plain, "data");
	if (!isWindows) chmodSync(plain, 0o644);
	return { dir, binName };
}

describe("findExecutableSync", () => {
	test("finds a runnable binary on the injected PATH", () => {
		const { dir, binName } = fixture();
		const env = { PATH: dir, PATHEXT: ".CMD" };
		expect(findExecutableSync("tool", { env })).toBe(join(dir, binName));
	});

	test("returns undefined for a missing name", () => {
		const env = { PATH: mkdtempSync(join(tempDir(), "which-empty-")) };
		expect(findExecutableSync("definitely-not-here-xyz", { env })).toBeUndefined();
	});

	test.skipIf(isWindows)("ignores a non-executable file (POSIX)", () => {
		const { dir } = fixture();
		expect(findExecutableSync("notexec", { env: { PATH: dir } })).toBeUndefined();
	});

	test("empty name yields undefined", () => {
		expect(findExecutableSync("", { env: { PATH: "/usr/bin" } })).toBeUndefined();
	});

	test("scans multiple PATH entries in order", () => {
		const { dir, binName } = fixture();
		const env = { PATH: `/nonexistent-dir-abc${delimiter}${dir}`, PATHEXT: ".CMD" };
		expect(findExecutableSync("tool", { env })).toBe(join(dir, binName));
	});
});

describe("findExecutable (async) matches sync", () => {
	test("same result as sync for a real fixture", async () => {
		const { dir } = fixture();
		const env = { PATH: dir, PATHEXT: ".CMD" };
		const asyncFound = await findExecutable("tool", { env });
		const syncFound = findExecutableSync("tool", { env });
		expect(asyncFound).toBeDefined();
		expect(asyncFound).toBe(syncFound);
	});
});
