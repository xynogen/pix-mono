import { describe, expect, test } from "bun:test";
import { collectRefs, parseEnv, refsIn, resolveInput, resolveString, shellQuote } from "./lib.ts";

// Literal dotenv braced ref syntax, assembled from char codes so no `${...}`
// placeholder appears in source (it is intentional test data, not a mistake).
const L = String.fromCharCode(36, 123); // "${"
const R = String.fromCharCode(125); // "}"
const braced = (k: string) => L + k + R;

describe("parseEnv", () => {
	test("handles export, comments, quotes, inline comments", () => {
		const env = parseEnv(
			[
				"# comment",
				"",
				"API_KEY=sk-123",
				"export TOKEN=abc",
				`QUOTED="a b c"`,
				"SINGLE='x y'",
				"PORT=3000 # inline",
			].join("\n"),
		);
		expect(env).toEqual({
			API_KEY: "sk-123",
			TOKEN: "abc",
			QUOTED: "a b c",
			SINGLE: "x y",
			PORT: "3000",
		});
	});

	test("ignores malformed lines", () => {
		expect(parseEnv("not a var\n=missingkey\n123=bad")).toEqual({});
	});
});

describe("refsIn / collectRefs", () => {
	const reg = new Map([
		["API_KEY", "sk-1"],
		["TOKEN", "t-2"],
	]);
	test("detects bare and braced refs, only known keys", () => {
		expect(refsIn(`Bearer $API_KEY and ${braced("TOKEN")} and $UNKNOWN`, reg).sort()).toEqual([
			"API_KEY",
			"TOKEN",
		]);
	});
	test("walks nested input objects and arrays", () => {
		const input = { url: "https://x/?k=$API_KEY", headers: [`Auth: ${braced("TOKEN")}`], n: 5 };
		expect(collectRefs(input, reg).sort()).toEqual(["API_KEY", "TOKEN"]);
	});
});

describe("resolveString", () => {
	const reg = new Map([["API_KEY", "sk-1"]]);
	test("raw substitution for non-shell", () => {
		expect(resolveString("k=$API_KEY", reg, false)).toBe("k=sk-1");
	});
	test("shell-quotes for bash", () => {
		expect(resolveString("k=$API_KEY", reg, true)).toBe("k='sk-1'");
	});
	test("leaves unknown refs untouched", () => {
		expect(resolveString("$OTHER", reg, false)).toBe("$OTHER");
	});
});

describe("shellQuote", () => {
	test("escapes embedded single quotes", () => {
		expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
	});
});

describe("resolveInput", () => {
	const reg = new Map([["TOKEN", "t-2"]]);
	test("mutates nested object in place", () => {
		const input = { a: "x $TOKEN", b: { c: [braced("TOKEN")] }, n: 1 };
		resolveInput(input, reg, false);
		expect(input).toEqual({ a: "x t-2", b: { c: ["t-2"] }, n: 1 });
	});
});
