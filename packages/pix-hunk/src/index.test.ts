import { expect, test } from "bun:test";
import registerHunk, { type HunkRunner } from "./index.ts";

type RenderTheme = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

type RenderContext = {
	expanded: boolean;
	isError: boolean;
	state: Record<string, unknown>;
	invalidate: () => void;
};

type ToolDef = {
	renderShell?: "self";
	renderCall: (
		args: { ops: Array<Record<string, unknown>> },
		theme: RenderTheme,
		context: RenderContext,
	) => { render: (width: number) => string[] };
	renderResult: (
		result: { content: Array<{ type: "text"; text: string }>; details: unknown },
		options: { expanded: boolean; isPartial: boolean },
		theme: RenderTheme,
		context: RenderContext,
	) => { render: (width: number) => string[] };
	execute: (
		id: string,
		params: { ops: Array<Record<string, unknown>>; maxCharacters?: number },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
};

const taggedTheme: RenderTheme = {
	fg: (color, text) => `[${color}]${text}[/${color}]`,
	bold: (text) => `[bold]${text}[/bold]`,
};

const renderContext = (expanded = false, collapsed = false): RenderContext => ({
	expanded,
	isError: false,
	state: collapsed ? { collapsed: true } : {},
	invalidate: () => {},
});

function rendered(component: { render: (width: number) => string[] }): string {
	return component.render(240).join("\n");
}

function capture(runner: HunkRunner): ToolDef {
	let tool: ToolDef | undefined;
	const pi = {
		registerTool(def: ToolDef) {
			tool = def;
		},
	} as never;
	registerHunk(pi, runner);
	if (!tool) throw new Error("hunk tool not registered");
	return tool;
}

test("renders a compact colored summary and hides internal ids from expanded UI", async () => {
	let call = 0;
	const runner: HunkRunner = async () => {
		call++;
		if (call === 1) {
			return {
				stdout: JSON.stringify({
					result: { filePath: "src/a.ts", hunkIndex: 0, selectedHunk: { newRange: [10, 20] } },
				}),
				stderr: "",
				code: 0,
			};
		}
		return {
			stdout: JSON.stringify({
				result: {
					commentId: "mcp:3681add-very-long-internal-id",
					filePath: "src/a.ts",
					hunkIndex: 0,
					side: "new",
					line: 13,
				},
			}),
			stderr: "",
			code: 0,
		};
	};
	const tool = capture(runner);
	const args = {
		ops: [
			{ action: "navigate", file: "src/a.ts", hunk: 1 },
			{ action: "comment", file: "src/a.ts", newLine: 13, summary: "Long body hidden" },
		],
	};
	const result = await tool.execute("render", args, undefined, undefined, { cwd: "/repo" });

	expect(tool.renderShell).toBe("self");
	expect(rendered(tool.renderCall(args, taggedTheme, renderContext()))).toContain(
		"[toolTitle][bold]hunk[/bold][/toolTitle] [dim]navigate +1[/dim]",
	);
	const compactContext = renderContext(false, true);
	expect(rendered(tool.renderCall(args, taggedTheme, compactContext))).toBe("");
	const compact = rendered(
		tool.renderResult(result, { expanded: false, isPartial: false }, taggedTheme, compactContext),
	);
	expect(compact).toContain("[toolTitle][bold]hunk[/bold][/toolTitle]");
	expect(compact).toContain("[dim]navigate +1[/dim]");
	expect(compact).toContain("[muted]2 ops · 1 comment[/muted]");
	expect(compact).not.toContain("mcp:3681add");
	expect(compact).not.toContain("─");

	const expanded = rendered(
		tool.renderResult(
			result,
			{ expanded: true, isPartial: false },
			taggedTheme,
			renderContext(true, true),
		),
	);
	expect(expanded).toContain("[success]────────────────────────────────");
	expect(expanded).toContain("[dim]src/a.ts:h1[/dim] [muted]· 1 comment[/muted]");
	expect(expanded).not.toContain("[text]navigate");
	expect(expanded).not.toContain("[text]comment");
	expect(expanded).not.toContain("[toolTitle]navigate");
	expect(expanded).not.toContain("[toolTitle]comment");
	expect(expanded).not.toContain("src/a.ts:new:13");
	expect(expanded).not.toContain("mcp:3681add");
	expect(expanded).not.toContain("Long body hidden");

	const partial = rendered(
		tool.renderResult(
			result,
			{ expanded: true, isPartial: true },
			taggedTheme,
			renderContext(true, true),
		),
	);
	expect(partial).not.toContain("─");

	const failed = await capture(async () => ({
		stdout: "",
		stderr: "session gone",
		code: 1,
	})).execute("render-error", { ops: [{ action: "list" }] }, undefined, undefined, {
		cwd: "/repo",
	});
	const failedExpanded = rendered(
		tool.renderResult(
			failed,
			{ expanded: true, isPartial: false },
			taggedTheme,
			renderContext(true, true),
		),
	);
	expect(failedExpanded).toContain("[error]────────────────────────────────");
	expect(failedExpanded).toContain("[error]list: session gone[/error]");
});

test("executes bulk operations in order and returns every parsed result", async () => {
	const calls: string[][] = [];
	const runner: HunkRunner = async (args) => {
		calls.push(args);
		return calls.length === 1
			? { stdout: '{"sessions":[]}', stderr: "", code: 0 }
			: { stdout: "", stderr: "No active Hunk sessions", code: 1 };
	};

	const result = await capture(runner).execute(
		"t1",
		{ ops: [{ action: "list" }, { action: "review", repo: "/work" }] },
		undefined,
		undefined,
		{ cwd: "/cwd" },
	);

	expect(calls).toEqual([
		["session", "list", "--json"],
		["session", "review", "--repo", "/work", "--json"],
	]);
	expect(result.content[0]?.text).toBe("list sessions=0\nreview error: No active Hunk sessions");
	expect(result.details).toEqual({
		_type: "hunkResult",
		outcome: "error",
		results: [
			{ action: "list", ok: true, data: { sessions: [] } },
			{ action: "review", ok: false, error: "No active Hunk sessions" },
		],
	});
});

test("summarizes review JSON as files and hunks instead of dumping it", async () => {
	const runner: HunkRunner = async () => ({
		stdout: JSON.stringify({
			review: {
				sessionId: "s1",
				title: "Working tree",
				selectedFile: { path: "src/a.ts" },
				files: [
					{
						path: "src/a.ts",
						additions: 5,
						deletions: 2,
						patch: "@@ -10,2 +10,3 @@\n-old\n+new",
						hunks: [
							{
								index: 0,
								header: "@@ -10,2 +10,3 @@",
								oldRange: [10, 11],
								newRange: [10, 12],
							},
						],
					},
				],
			},
		}),
		stderr: "",
		code: 0,
	});
	const result = await capture(runner).execute(
		"t-review",
		{ ops: [{ action: "review" }] },
		undefined,
		undefined,
		{ cwd: "/repo" },
	);

	expect(result.content[0]?.text).toBe(
		"review s1 Working tree\n" +
			"  selected src/a.ts\n" +
			"  src/a.ts +5 -2\n" +
			"    h1 old=10-11 new=10-12\n" +
			"    patch\n" +
			"      @@ -10,2 +10,3 @@\n" +
			"      -old\n" +
			"      +new",
	);
	expect(result.content[0]?.text).not.toContain("sessionId");
});

test("returns exact comment ids and locations for follow-up actions", async () => {
	let call = 0;
	const runner: HunkRunner = async () => {
		call++;
		if (call === 1) {
			return {
				stdout: JSON.stringify({
					result: {
						commentId: "c17",
						filePath: "src/a.ts",
						hunkIndex: 0,
						side: "new",
						line: 12,
					},
				}),
				stderr: "",
				code: 0,
			};
		}
		if (call === 2) {
			return {
				stdout: JSON.stringify({
					comments: [
						{
							noteId: "note-81bc",
							filePath: "src/a.ts",
							hunkIndex: 0,
							newRange: [13, 13],
							author: "xynogen",
							body: "Can this be simpler?",
						},
					],
				}),
				stderr: "",
				code: 0,
			};
		}
		return {
			stdout: JSON.stringify({
				result: { commentId: "c17", removed: true, remainingCommentCount: 1 },
			}),
			stderr: "",
			code: 0,
		};
	};
	const result = await capture(runner).execute(
		"t-comments",
		{
			ops: [
				{ action: "comment", file: "src/a.ts", newLine: 12, summary: "Fix this" },
				{ action: "comment_list", type: "user" },
				{ action: "comment_rm", commentId: "c17" },
			],
		},
		undefined,
		undefined,
		{ cwd: "/repo" },
	);

	expect(result.content[0]?.text).toBe(
		"comment c17 src/a.ts:new:12 h1\n" +
			"comment_list\n" +
			"note-81bc src/a.ts:new:13 h1 @xynogen: Can this be simpler?\n" +
			"comment_rm c17 remaining=1",
	);
});

test("budgets each operation so a large patch cannot hide later results", async () => {
	let call = 0;
	const runner: HunkRunner = async () => {
		call++;
		return call === 1
			? {
					stdout: JSON.stringify({
						review: {
							title: "Large review",
							files: [
								{
									path: "src/large.ts",
									additions: 1,
									deletions: 0,
									hunks: [],
									patch: `+${"x".repeat(60_000)}`,
								},
							],
						},
					}),
					stderr: "",
					code: 0,
				}
			: {
					stdout: JSON.stringify({
						result: {
							commentId: "c-final",
							filePath: "src/final.ts",
							hunkIndex: 2,
							side: "new",
							line: 44,
						},
					}),
					stderr: "",
					code: 0,
				};
	};
	const result = await capture(runner).execute(
		"t2",
		{
			ops: [
				{ action: "review", includePatch: true },
				{ action: "comment", file: "src/final.ts", newLine: 44, summary: "Fix" },
			],
		},
		undefined,
		undefined,
		{ cwd: "/repo" },
	);

	expect(result.content[0]?.text.length).toBeLessThanOrEqual(10_000);
	expect(result.content[0]?.text).toContain("review Large review");
	expect(result.content[0]?.text).toContain("[truncated; full result in tool details]");
	expect(result.content[0]?.text).toContain("comment c-final src/final.ts:new:44 h3");
	expect(JSON.stringify(result.details).length).toBeGreaterThan(60_000);
});

test("allows a bounded model-output override", async () => {
	const huge = JSON.stringify({
		review: {
			title: "Large review",
			files: [
				{
					path: "src/large.ts",
					additions: 1,
					deletions: 0,
					hunks: [],
					patch: `+${"x".repeat(30_000)}`,
				},
			],
		},
	});
	const runner: HunkRunner = async () => ({ stdout: huge, stderr: "", code: 0 });
	const result = await capture(runner).execute(
		"t-limit",
		{ ops: [{ action: "review", includePatch: true }], maxCharacters: 20_000 },
		undefined,
		undefined,
		{ cwd: "/repo" },
	);

	expect(result.content[0]?.text.length).toBeGreaterThan(10_500);
	expect(result.content[0]?.text.length).toBeLessThanOrEqual(20_000);
	expect(result.content[0]?.text).toContain("[truncated; full result in tool details]");
});

test("reports a missing Hunk executable clearly", async () => {
	const runner: HunkRunner = async () => ({
		stdout: "",
		stderr: "spawn hunk ENOENT",
		code: 1,
	});
	const result = await capture(runner).execute(
		"t3",
		{ ops: [{ action: "list" }] },
		undefined,
		undefined,
		{ cwd: "/repo" },
	);

	expect(result.content[0]?.text).toContain("Hunk CLI not found");
});
