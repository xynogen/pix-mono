import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomicSync } from "./atomic-write.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atomic-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomicSync", () => {
	test("writes contents and creates parent dirs", () => {
		const target = join(dir, "nested", "deep", "file.json");
		writeFileAtomicSync(target, '{"ok":true}');
		expect(readFileSync(target, "utf8")).toBe('{"ok":true}');
	});

	test("overwrites atomically and leaves no temp files", () => {
		const target = join(dir, "state.json");
		writeFileAtomicSync(target, "first");
		writeFileAtomicSync(target, "second");
		expect(readFileSync(target, "utf8")).toBe("second");
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("cleans up temp file and preserves old content when rename target is a dir", () => {
		const target = join(dir, "collide");
		writeFileAtomicSync(target, "original");
		rmSync(target);
		// Make target a non-empty dir so rename-over fails.
		writeFileAtomicSync(join(target, "child"), "x");
		expect(() => writeFileAtomicSync(target, "new")).toThrow();
		expect(readdirSync(dir).filter((f) => f.startsWith("collide.") && f.endsWith(".tmp"))).toEqual(
			[],
		);
	});

	test("accepts Uint8Array", () => {
		const target = join(dir, "bin");
		writeFileAtomicSync(target, new Uint8Array([1, 2, 3]));
		writeFileAtomicSync(target, new Uint8Array([9]));
		expect([...readFileSync(target)]).toEqual([9]);
	});
});
