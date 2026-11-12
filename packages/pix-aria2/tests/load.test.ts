import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("loads through Pi's Jiti extension loader", () => {
	const result = spawnSync(
		"../../node_modules/.bin/pi",
		["-ne", "-e", "./src/index.ts", "--list-models"],
		{ cwd: new URL("..", import.meta.url), encoding: "utf8" },
	);

	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
});
