import { describe, expect, it } from "bun:test";
import { prepareEditArguments } from "../src/edit.ts";

const A = "3#ABC";
const hash = (o: object) => ({ op: "replace", pos: A, lines: ["x"], ...o });
const fail = (args: unknown): string => {
	try {
		prepareEditArguments(args);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected a bad-arguments error");
};

// One row per recorded failure class: [name, args, field path, fix pattern].
const cases: Array<[string, unknown, string, RegExp]> = [
	["unparsable item", { path: "a", edits: ["not json"] }, "edits[0]", /each edit is one object/],
	[
		"lowercase hash",
		{ path: "a", edits: [hash({ pos: "3#abc" })] },
		"edits[0].pos",
		/uppercase hex/,
	],
	["bad end", { path: "a", edits: [hash({ end: "x" })] }, "edits[0].end", /LINE#HASH from read/],
	[
		"missing lines",
		{ path: "a", edits: [{ op: "replace", pos: A }] },
		"edits[0].lines",
		/add lines: \[\]/,
	],
	[
		"bad op",
		{ path: "a", edits: [hash({ op: "delete" })] },
		"edits[0].op",
		/replace, insert_before or insert_after/,
	],
	[
		"unknown item field",
		{ path: "a", edits: [hash({ text: "x" })] },
		"edits[0].text",
		/op, pos, end\?, lines/,
	],
	[
		"unknown top field",
		{ path: "a", edits: [hash({})], oldText: "x" },
		"oldText",
		/only path and edits/,
	],
	[
		"mixed formats",
		{ path: "a", edits: [hash({}), { oldText: "a", newText: "b" }] },
		"edits",
		/hash at \[0\], exact at \[1\]/,
	],
	[
		"empty oldText",
		{ path: "a", edits: [{ oldText: "", newText: "b" }] },
		"edits[0].oldText",
		/non-empty exact/,
	],
	["missing path", { edits: [hash({})] }, "path", /missing/],
];

describe("edit argument errors", () => {
	it.each(cases)("%s names the field and the fix", (_name, args, field, fix) => {
		const message = fail(args);
		const [head, ...rest] = message.split("\n");
		expect(head).toBe("edit: bad arguments");
		expect(rest.at(-1)).toMatch(/^Fix: /);
		const row = rest.find((line) => line.startsWith(`- ${field}`));
		expect(row).toMatch(fix);
		expect(Buffer.byteLength(message)).toBeLessThan(600);
	});

	it("reports only the hash branch for a hash call", () => {
		expect(fail({ path: "a", edits: [hash({ pos: "3#abc" })] }).split("\n")).toHaveLength(3);
	});

	it("caps rows at 5 and clips long values to 40 chars", () => {
		const many = fail({
			path: "a",
			edits: Array.from({ length: 7 }, () => hash({ pos: "x".repeat(99) })),
		});
		const lines = many.split("\n");
		expect(lines[0]).toBe("edit: 7 bad arguments, first 5");
		expect(lines).toHaveLength(7);
		expect(lines[1]).toMatch(/^- edits\[0\]\.pos "x{38}…: /);
		expect(Buffer.byteLength(many)).toBeLessThan(600);
	});

	it("repairs a JSON-string edit item and passes valid calls through", () => {
		const edit = hash({});
		expect(prepareEditArguments({ path: "a", edits: [JSON.stringify(edit)] })).toEqual({
			path: "a",
			edits: [edit],
		});
		const exact = { path: "a", edits: [{ oldText: "a", newText: "" }] };
		expect(prepareEditArguments(exact)).toEqual(exact);
	});
});
