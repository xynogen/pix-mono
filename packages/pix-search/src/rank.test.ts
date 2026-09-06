import { expect, test } from "bun:test";
import { rankFiles, withDirectories } from "./rank.ts";

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

test("withDirectories appends every ancestor folder with a trailing slash", () => {
	const out = withDirectories(["src/a/b.ts", "README.md"]);
	expect(out).toContain("src/");
	expect(out).toContain("src/a/");
	// files preserved, root file has no dir to add
	expect(out).toContain("src/a/b.ts");
	expect(out).toContain("README.md");
});

test("withDirectories dedupes and does not duplicate an existing entry", () => {
	const out = withDirectories(["src/", "src/a.ts"]);
	expect(out.filter((p) => p === "src/").length).toBe(1);
});

test("folders are pickable: rankFiles keeps a dir label with slash", () => {
	const ranked = rankFiles(withDirectories(["src/a/b.ts"]), "src", new Map());
	const paths = ranked.map((r) => r.path);
	expect(paths).toContain("src/");
	expect(paths).toContain("src/a/");
});
