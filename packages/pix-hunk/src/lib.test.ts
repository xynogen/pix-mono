import { describe, expect, test } from "bun:test";
import { buildHunkArgs, type HunkOp } from "./lib.ts";

describe("buildHunkArgs", () => {
	test("lists sessions as JSON", () => {
		expect(buildHunkArgs({ action: "list" }, "/repo")).toEqual(["session", "list", "--json"]);
	});

	test("builds documented argv for every review operation", () => {
		const cases: Array<[HunkOp, string[]]> = [
			[{ action: "get" as const }, ["session", "get", "--repo", "/repo", "--json"]],
			[{ action: "context" as const, sessionId: "s1" }, ["session", "context", "s1", "--json"]],
			[
				{ action: "review" as const, includePatch: true },
				["session", "review", "--repo", "/repo", "--include-patch", "--json"],
			],
			[
				{ action: "navigate" as const, file: "src/a.ts", hunk: 2 },
				["session", "navigate", "--repo", "/repo", "--file", "src/a.ts", "--hunk", "2", "--json"],
			],
			[
				{ action: "navigate" as const, nextComment: true },
				["session", "navigate", "--repo", "/repo", "--next-comment", "--json"],
			],
			[
				{
					action: "comment" as const,
					file: "src/a.ts",
					newLine: 42,
					summary: "Fix this",
					rationale: "It breaks",
					focus: true,
				},
				[
					"session",
					"comment",
					"add",
					"--repo",
					"/repo",
					"--file",
					"src/a.ts",
					"--new-line",
					"42",
					"--summary",
					"Fix this",
					"--rationale",
					"It breaks",
					"--focus",
					"--json",
				],
			],
			[
				{ action: "comment_list" as const, file: "src/a.ts", type: "user" as const },
				[
					"session",
					"comment",
					"list",
					"--repo",
					"/repo",
					"--file",
					"src/a.ts",
					"--type",
					"user",
					"--json",
				],
			],
			[
				{ action: "comment_rm" as const, commentId: "c1" },
				["session", "comment", "rm", "--repo", "/repo", "c1", "--json"],
			],
			[
				{
					action: "highlight" as const,
					file: "src/a.ts",
					oldLine: 9,
					start: 1,
					end: 4,
					tone: "warning" as const,
				},
				[
					"session",
					"highlight",
					"add",
					"--repo",
					"/repo",
					"--file",
					"src/a.ts",
					"--old-line",
					"9",
					"--start",
					"1",
					"--end",
					"4",
					"--tone",
					"warning",
					"--json",
				],
			],
			[
				{ action: "highlight_clear" as const, file: "src/a.ts" },
				["session", "highlight", "clear", "--repo", "/repo", "--file", "src/a.ts", "--json"],
			],
			[
				{ action: "reload" as const, reloadArgs: ["diff", "main...HEAD", "--", "src"] },
				[
					"session",
					"reload",
					"--repo",
					"/repo",
					"--json",
					"--",
					"diff",
					"main...HEAD",
					"--",
					"src",
				],
			],
		];

		for (const [op, expected] of cases) {
			expect(buildHunkArgs(op, "/repo")).toEqual(expected);
		}
	});

	test("rejects invalid action fields before execution", () => {
		const invalid = [
			[{ action: "navigate" as const, file: "a.ts" }, "navigation target"],
			[
				{ action: "navigate" as const, nextComment: true, prevComment: true },
				"one comment direction",
			],
			[{ action: "comment" as const, file: "a.ts", newLine: 1 }, "summary"],
			[
				{ action: "highlight" as const, file: "a.ts", newLine: 1, start: 4, end: 4 },
				"greater than start",
			],
			[{ action: "comment_rm" as const }, "commentId"],
		] as const;

		for (const [op, message] of invalid) {
			expect(() => buildHunkArgs(op, "/repo")).toThrow(message);
		}
	});
});
