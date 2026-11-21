import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

// A cold first launch of Pi on a fresh CI runner can exceed bun's 5 s default.
test("loads through Pi's Jiti extension loader", () => {
	const result = spawnSync(
		"../../node_modules/.bin/pi",
		["-ne", "-e", "./src/index.ts", "--list-models"],
		{ cwd: new URL("..", import.meta.url), encoding: "utf8" },
	);

	// Pi 1.6 prints its startup model warning (and its doc paths) on stderr; the sandbox has no models.
	const stderr = stripVTControlCharacters(result.stderr)
		.split(/\r?\n/)
		.filter(
			(line) => line && !line.startsWith("Warning: No models available.") && !line.startsWith("  "),
		)
		.join("\n");
	expect(stderr).toBe("");
	expect(result.status).toBe(0);
}, 30_000);
