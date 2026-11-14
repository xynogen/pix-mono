import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCodeFiles } from "../src/files.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(): string {
	const root = mkdtempSync(join(tmpdir(), "pix-astgrep-files-"));
	roots.push(root);
	mkdirSync(join(root, "src"));
	mkdirSync(join(root, "node_modules"));
	writeFileSync(join(root, "src", "a.ts"), "");
	writeFileSync(join(root, "src", "notes.txt"), "");
	writeFileSync(join(root, "node_modules", "dep.ts"), "");
	return root;
}

test("collectCodeFiles walks code files, skips vendored dirs, and honours the cap", async () => {
	const root = tree();
	const out: string[] = [];
	await collectCodeFiles(root, out, 10);
	expect(out).toEqual([join(root, "src", "a.ts")]);

	const capped: string[] = ["x"];
	await collectCodeFiles(root, capped, 1);
	expect(capped).toEqual(["x"]);
});

test("collectCodeFiles accepts one file, ignores a missing path, and stops on abort", async () => {
	const root = tree();
	const single: string[] = [];
	await collectCodeFiles(join(root, "src", "a.ts"), single, 10);
	expect(single).toEqual([join(root, "src", "a.ts")]);

	const missing: string[] = [];
	await collectCodeFiles(join(root, "nope"), missing, 10);
	expect(missing).toEqual([]);

	const controller = new AbortController();
	controller.abort();
	await expect(collectCodeFiles(root, [], 10, controller.signal)).rejects.toThrow();
});
