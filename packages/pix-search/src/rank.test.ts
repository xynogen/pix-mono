import { expect, test } from "bun:test";
import { atToken, rankFiles } from "./rank.ts";

const files = ["src/index.ts", "src/rank.ts", "docs/index.md", "README.md", "a b/note.txt"];

test("empty query returns all files, recency-ordered", () => {
	const recency = new Map([["README.md", 1]]);
	const ranked = rankFiles(files, "", recency);
	expect(ranked.length).toBe(files.length);
	expect(ranked[0]?.path).toBe("README.md"); // recency boost floats it up
});

test("query filters out non-matching files", () => {
	const ranked = rankFiles(files, "rank", new Map());
	expect(ranked.map((r) => r.path)).toEqual(["src/rank.ts"]);
});

test("exact filename outranks path-only match", () => {
	const ranked = rankFiles(files, "index.ts", new Map());
	expect(ranked[0]?.path).toBe("src/index.ts");
});

test("recency boosts an otherwise-tied file", () => {
	const recency = new Map([["docs/index.md", 1]]);
	const ranked = rankFiles(files, "index", recency);
	// both index.* match; the recent one wins
	expect(ranked[0]?.path).toBe("docs/index.md");
});

test("label is the basename, dirs keep trailing slash", () => {
	const ranked = rankFiles(["src/deep/", "src/index.ts"], "", new Map());
	const byPath = new Map(ranked.map((r) => [r.path, r.label]));
	expect(byPath.get("src/deep/")).toBe("deep/");
	expect(byPath.get("src/index.ts")).toBe("index.ts");
});

test("limit caps the result count", () => {
	const many = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
	expect(rankFiles(many, "", new Map(), 5).length).toBe(5);
});

test("atToken quotes only paths with spaces", () => {
	expect(atToken("src/index.ts")).toBe("@src/index.ts");
	expect(atToken("a b/note.txt")).toBe('@"a b/note.txt"');
});
