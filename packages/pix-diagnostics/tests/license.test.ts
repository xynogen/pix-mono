import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("ships the pi-lens MIT notice", () => {
	const text = readFileSync(join(root, "LICENSE.pi-lens"), "utf8");
	expect(text).toContain("MIT License");
	expect(text).toContain("Apostolos Mantzaris and pi-lens contributors");
});
