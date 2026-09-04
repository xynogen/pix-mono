import { expect, test } from "bun:test";
import { scoreFilename } from "./rg.ts";

test("exact filename match scores highest", () => {
	expect(scoreFilename("src/index.ts", "index.ts")).toBe(100);
});

test("filename starts-with scores 80", () => {
	expect(scoreFilename("src/index.ts", "ind")).toBe(80);
});

test("filename contains query scores 60", () => {
	expect(scoreFilename("src/index.ts", "dex")).toBe(60);
});

test("full path contains query scores 30", () => {
	expect(scoreFilename("src/deep/nested/file.ts", "deep/nest")).toBe(30);
});

test("fuzzy match on filename scores 20", () => {
	// i-n-x matches i[n]de[x].ts
	expect(scoreFilename("src/index.ts", "inx")).toBe(20);
});

test("no match returns 0", () => {
	expect(scoreFilename("src/index.ts", "zzz")).toBe(0);
});

test("empty query returns 1", () => {
	expect(scoreFilename("src/index.ts", "")).toBe(1);
});
