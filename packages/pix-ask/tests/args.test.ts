import { describe, expect, it } from "bun:test";
import { prepareAskArguments } from "../src/args.ts";

const option = (label = "a") => ({ label, description: "d" });
const q = (o: object = {}) => ({
	question: "Q?",
	header: "H",
	options: [option(), option("b")],
	...o,
});
const fail = (args: unknown): string => {
	try {
		prepareAskArguments(args);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected a bad-arguments error");
};

// One row per recorded failure class: [name, args, field path, fix pattern].
const cases: Array<[string, unknown, string, RegExp]> = [
	[
		"long header",
		{ questions: [q({ header: "x".repeat(20) })] },
		"questions[0].header",
		/20 chars, max 16/,
	],
	[
		"long label",
		{ questions: [q({ options: [option("y".repeat(70)), option()] })] },
		"questions[0].options[0].label",
		/70 chars, max 60/,
	],
	[
		"option not an object",
		{ questions: [q({ options: ["a", "b"] })] },
		"questions[0].options[0]",
		/\{label, description, preview\?\}/,
	],
	[
		"question not an object",
		{ questions: ["text"] },
		"questions[0]",
		/\{question, header, options, multiSelect\?\}/,
	],
	[
		"single-select bundles subsets",
		{ questions: [q({ options: [option("All containers"), option("Only the stopped ones")] })] },
		"questions[0].options",
		/set multiSelect: true with one option per item/,
	],
];

describe("ask_user argument errors", () => {
	it.each(cases)("%s names the field and the fix", (_name, args, field, fix) => {
		const message = fail(args);
		const [head, ...rest] = message.split("\n");
		expect(head).toBe("ask_user: bad arguments");
		expect(rest.at(-1)).toMatch(/^Fix: /);
		expect(rest.find((line) => line.startsWith(`- ${field}`))).toMatch(fix);
		expect(Buffer.byteLength(message)).toBeLessThan(600);
	});

	it("parses JSON-string payloads and never truncates valid input", () => {
		const questions = [q({ header: "x".repeat(16) })];
		expect(prepareAskArguments({ questions: JSON.stringify(questions) })).toEqual({ questions });
		expect(prepareAskArguments({ questions: [JSON.stringify(questions[0])] })).toEqual({
			questions,
		});
	});

	it("accepts subset labels in multiSelect and look-alike single-select labels", () => {
		const subsets = [option("All"), option("Only api")];
		for (const question of [
			q({ options: subsets, multiSelect: true }),
			q({ options: [option("Allow"), option("Only once")] }),
			q({ options: [option("All files"), option("Changed files")] }),
		])
			expect(prepareAskArguments({ questions: [question] })).toEqual({ questions: [question] });
	});
});
