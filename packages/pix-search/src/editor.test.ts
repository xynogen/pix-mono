import { expect, test } from "bun:test";
import { atStartsMention } from "./editor.ts";

test("@ at line start begins a mention", () => {
	expect(atStartsMention("")).toBe(true);
});

test("@ after a space begins a mention", () => {
	expect(atStartsMention("look at ")).toBe(true);
});

test("@ after a newline-adjacent tab begins a mention", () => {
	expect(atStartsMention("foo\t")).toBe(true);
});

test("@ mid-word (e.g. email) does not begin a mention", () => {
	expect(atStartsMention("me")).toBe(false);
	expect(atStartsMention("user@")).toBe(false);
});
