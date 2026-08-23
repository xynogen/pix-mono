import { describe, expect, test } from "bun:test";
import { dirIcon, fileColor, fileIcon } from "./icons.ts";

const theme = {
	fg: (key: string, text: string) => `<${key}>${text}</${key}>`,
};

describe("theme-derived file icons", () => {
	test("uses semantic theme roles instead of embedded ANSI colors", () => {
		expect(fileIcon("example.ts", theme)).toContain("<syntaxType>");
		expect(fileIcon("data.json", theme)).toContain("<syntaxNumber>");
		expect(fileIcon("unknown.zzz", theme)).toContain("<muted>");
	});

	test("themes directory icons with the active accent", () => {
		expect(dirIcon(theme)).toContain("<accent>");
	});
});

describe("theme-derived file name color", () => {
	test("colors a filename with the same role as its icon", () => {
		expect(fileColor("example.ts", "example.ts", theme)).toBe(
			"<syntaxType>example.ts</syntaxType>",
		);
		expect(fileColor("package.json", "package.json", theme)).toContain("<syntaxString>");
	});

	test("falls back to the text role for an unknown extension", () => {
		expect(fileColor("notes.zzz", "notes.zzz", theme)).toBe("<text>notes.zzz</text>");
	});

	test("passes the name through unchanged when no theme is supplied", () => {
		expect(fileColor("example.ts", "example.ts")).toBe("example.ts");
	});
});
