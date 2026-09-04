import { expect, test } from "bun:test";
import { buildRecencyScores } from "./recency.ts";

test("buildRecencyScores assigns decaying scores", () => {
	const output = [
		"",
		"src/a.ts",
		"src/b.ts",
		"",
		"src/b.ts", // duplicate — should keep first (higher) score
		"src/c.ts",
		"",
	].join("\n");

	const scores = buildRecencyScores(output);

	expect(scores.size).toBe(3);
	// First file gets highest score
	expect(scores.get("src/a.ts")!).toBeGreaterThan(scores.get("src/b.ts")!);
	expect(scores.get("src/b.ts")!).toBeGreaterThan(scores.get("src/c.ts")!);
	// First file score is 0.97^0 = 1
	expect(scores.get("src/a.ts")).toBe(1);
});

test("empty git output returns empty map", () => {
	expect(buildRecencyScores("").size).toBe(0);
});

test("ignores commit lines", () => {
	const output = "commit abc123\n\nsrc/x.ts\n";
	const scores = buildRecencyScores(output);
	expect(scores.has("commit abc123")).toBe(false);
	expect(scores.has("src/x.ts")).toBe(true);
});
