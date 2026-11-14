import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { topLevelDirs } from "../src/fs.ts";

test("topLevelDirs lists only top-level folders and caps at limit", () => {
	const root = mkdtempSync(join(tmpdir(), "pix-fs-"));
	try {
		mkdirSync(join(root, "src", "deep"), { recursive: true });
		mkdirSync(join(root, "docs"));
		writeFileSync(join(root, "a.ts"), "");
		writeFileSync(join(root, "src", "deep", "c.ts"), "");
		expect(topLevelDirs(root).sort()).toEqual(["docs/", "src/"]);
		expect(topLevelDirs(root, 1)).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
