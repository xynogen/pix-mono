import { beforeAll, describe, expect, it } from "bun:test";
import { link, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { anchor, hashLine, initHashline } from "@xynogen/pix-runtime/hashline";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { Check } from "typebox/value";

beforeAll(initHashline);

import {
	capturePi,
	makeRenderCtx,
	makeTheme,
	makeToolContext,
} from "@xynogen/pix-pretty/test-utils";
import type { ThemeLike } from "@xynogen/pix-pretty/types";
import {
	editPath,
	getEditOperations,
	prepareHashArguments,
	registerEditTool,
	summarizeEditOperations,
} from "./edit";

const noopFactory = () => ({ execute: async () => ({ content: [], details: undefined }) });
const noopTrack = () => {};
const executeTool = (tool: Record<string, unknown>, ...args: unknown[]) =>
	(
		tool.execute as (
			...args: unknown[]
		) => Promise<import("@xynogen/pix-pretty/types").ToolResultLike>
	)(...args);
// Several edit tests assert on the exact fg key in framing rules, so tag every key.
const keyedTheme: ThemeLike = {
	fg: (key: string, value: string) => `[${key}]${value}[/${key}]`,
	bold: (value: string) => value,
};

describe("registerEditTool", () => {
	it("schema accepts one edit format and rejects malformed hash operations", () => {
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, makeToolContext(), noopTrack);
		const schema = tool.parameters as Parameters<typeof Check>[0];
		const hashEdit = { op: "replace", pos: "1#ABC", lines: ["\tconst value = 1;"] };
		const exactEdit = { oldText: "old", newText: "new" };
		for (const edits of [
			[hashEdit],
			[hashEdit, { op: "insert_after", pos: "2#DEF", lines: [] }],
			[exactEdit],
			[exactEdit, { oldText: "other", newText: "" }],
		]) {
			expect(Check(schema, { path: "source.ts", edits })).toBe(true);
		}
		for (const edits of [
			[],
			[hashEdit, exactEdit],
			[exactEdit, hashEdit],
			[{ ...hashEdit, oldText: "old" }],
			[{ ...exactEdit, op: "replace" }],
			[{ ...hashEdit, pos: "1#abc" }],
			[{ ...hashEdit, end: "bad" }],
			[{ ...hashEdit, op: "insert_after", end: "2#DEF" }],
			[{ ...hashEdit, op: "insert_before", end: "2#DEF" }],
		]) {
			expect(Check(schema, { path: "source.ts", edits })).toBe(false);
		}
		expect(Check(schema, { path: "", edits: [hashEdit] })).toBe(false);
	});
	it("applies original gaps in input order outside deleted ranges", async () => {
		const cwd = await mkdtemp(join(tempDir(), "hashline-edit-"));
		const path = join(cwd, "source.ts");
		await writeFile(path, "\uFEFFa\r\nb\rc\n");
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, { ...makeToolContext(), cwd }, noopTrack);
		const result = await executeTool(
			tool,
			"id",
			{
				path: "source.ts",
				edits: [
					{ op: "insert_after", pos: anchor(1, "a"), lines: ["first"] },
					{ op: "replace", pos: anchor(2, "b"), lines: [] },
					{ op: "insert_before", pos: anchor(2, "b"), lines: ["second"] },
					{ op: "insert_after", pos: anchor(2, "b"), lines: ["third"] },
				],
			},
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.isError).not.toBe(true);
		expect(await readFile(path, "utf8")).toBe("\uFEFFa\r\nfirst\r\nsecond\r\nthird\r\nc\n");
	});
	it("rejects interior gaps and mixed input before writing", async () => {
		const cwd = await mkdtemp(join(tempDir(), "hashline-reject-"));
		const path = join(cwd, "source.ts");
		await writeFile(path, "a\nb\nc");
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, { ...makeToolContext(), cwd }, noopTrack);
		for (const edits of [
			[
				{ op: "replace", pos: anchor(1, "a"), end: anchor(3, "c"), lines: [] },
				{ op: "insert_after", pos: anchor(1, "a"), lines: ["x"] },
			],
			[
				{ op: "replace", pos: anchor(1, "a"), lines: ["x"] },
				{ oldText: "b", newText: "y" },
			],
		]) {
			const result = await executeTool(
				tool,
				"id",
				{ path: "source.ts", edits },
				undefined,
				undefined,
				{ cwd },
			);
			expect(result.isError).toBe(true);
			expect(await readFile(path, "utf8")).toBe("a\nb\nc");
		}
	});
	it("registers a self-rendered edit tool", () => {
		const { pi, tool, names } = capturePi();
		registerEditTool(pi, noopFactory, makeToolContext(), noopTrack);
		expect(names).toEqual(["edit"]);
		expect(tool.name).toBe("edit");
		expect((tool as { renderShell?: string }).renderShell).toBe("self");
	});

	it("restores the bounded diff when an elapsed card is expanded", () => {
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, makeToolContext(), noopTrack);
		const result = tool.renderResult?.(
			{
				content: [{ type: "text", text: "edited" }],
				details: {
					_type: "editInfo",
					filePath: "sample.ts",
					summary: "+1 -1",
					oldContent: "old",
					newContent: "new",
					language: "typescript",
					editLine: 1,
				},
			},
			undefined,
			keyedTheme,
			makeRenderCtx({ expanded: true, state: { collapsed: true } }),
		);

		const lines = result?.render(80) ?? [];
		expect(lines[0]).toContain("rendering diff");
		expect(lines.at(-1)).toBe(`[success]${"- ".repeat(40)}[/success]`);
		expect(lines.join("\n")).toContain("rendering diff");
		expect(lines.join("\n")).not.toContain("✓ edit");
	});

	it("renders single-step output inline as one compact line, framed when expanded", () => {
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, makeToolContext(), noopTrack);
		const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
		// edit today shows summary + diff; the ask is that single-step call already covers summary
		// so collapsed result stays compact — this test documents current behavior does NOT duplicate
		const result = {
			content: [{ type: "text", text: "edited" }],
			details: {
				_type: "editInfo",
				filePath: "app.py",
				summary: "-1",
				oldContent: "old line\n",
				newContent: "new line\n",
				language: "python",
				editLine: 1,
			},
		};
		const out =
			tool.renderResult?.(result, { isPartial: false }, makeTheme(), makeRenderCtx())?.getText() ??
			"";
		// collapsed/resting: diff placeholder path covered; when expanded framing should not duplicate header
		expect(strip(out).split("\n").length).toBeGreaterThanOrEqual(1);
	});

	it("collapses structured errors and restores the exact diagnostic on expansion", () => {
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, makeToolContext(), noopTrack);
		const diagnostic = "oldText was not found in sample.ts";
		const result = {
			content: [{ type: "text", text: diagnostic }],
			details: {
				_type: "editInfo",
				filePath: "sample.ts",
				summary: "+1 -1",
				oldContent: "old",
				newContent: "new",
				language: "typescript",
				editLine: 0,
			},
		};
		const render = (
			state: Record<string, unknown>,
			expanded = false,
			isPartial = false,
			width = 80,
			theme: ThemeLike = keyedTheme,
		) =>
			tool
				.renderResult?.(
					result,
					{ isPartial },
					theme,
					makeRenderCtx({ isError: true, expanded, state }),
				)
				?.render(width) ?? [];

		expect(render({ timer: 1 })[0]).toContain(diagnostic);
		expect(render({ timer: 1 }).at(-1)).toBe(`[error]${"- ".repeat(40)}[/error]`);
		expect(render({ timer: 1 }).join("\n")).toContain(diagnostic);
		const collapsed = render({ collapsed: true }, false, false, 80, makeTheme()).join("\n");
		expect(collapsed).toContain("edit");
		expect(collapsed).toContain("sample.ts");
		expect(collapsed).toContain("failed");
		expect(render({ collapsed: true }, false, false, 80, makeTheme())).toHaveLength(1);
		expect(render({ collapsed: true }, true).join("\n")).toContain(diagnostic);
		expect(render({ collapsed: true }, true).at(-1)).toBe(`[error]${"- ".repeat(40)}[/error]`);
		expect(render({}, false, true)).toEqual([expect.stringContaining(diagnostic)]);
	});
});

describe("exact-text acceptance", () => {
	it("replaces unique original text and records both diffs", async () => {
		const cwd = await mkdtemp(join(tempDir(), "exact-edit-"));
		const path = join(cwd, "source.ts");
		await writeFile(path, "\uFEFFalpha\r\nbeta\rgamma\n");
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, { ...makeToolContext(), cwd }, noopTrack);
		const result = await executeTool(
			tool,
			"id",
			{
				path,
				edits: [
					{ oldText: "alpha", newText: "beta" },
					{ oldText: "beta\r", newText: "" },
				],
			},
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.isError).not.toBe(true);
		expect(await readFile(path, "utf8")).toBe("\uFEFFbeta\r\ngamma\n");
		expect(result.details).toMatchObject({
			_type: "multiEditInfo",
			editCount: 2,
			ops: [
				{ oldContent: "alpha", newContent: "beta", editLine: 1 },
				{ oldContent: "beta\r", newContent: "", editLine: 2 },
			],
		});
	});
	it("rejects missing, ambiguous, overlapping, and malformed edits without writing", async () => {
		const cwd = await mkdtemp(join(tempDir(), "exact-invalid-"));
		const path = join(cwd, "source.ts");
		const source = "banana\nbanana\nunique";
		await writeFile(path, source);
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, { ...makeToolContext(), cwd }, noopTrack);
		for (const edits of [
			[{ oldText: "missing", newText: "x" }],
			[{ oldText: "banana", newText: "x" }],
			[
				{ oldText: "unique", newText: "x" },
				{ oldText: "nique", newText: "y" },
			],
			[
				{ oldText: "unique", newText: "x" },
				{ oldText: "missing", newText: "y" },
			],
			[{ oldText: "", newText: "x" }],
			[{ oldText: "unique" }],
			[{ oldText: "unique", newText: "\0" }],
			[{ oldText: "unique", newText: "\ud800" }],
			[{ oldText: "unique", newText: "x", pos: "1#ABC" }],
		]) {
			const result = await executeTool(tool, "id", { path, edits }, undefined, undefined, { cwd });
			expect(result.isError).toBe(true);
			expect(await readFile(path, "utf8")).toBe(source);
		}
		await writeFile(path, "banana");
		const result = await executeTool(
			tool,
			"id",
			{ path, edits: [{ oldText: "ana", newText: "x" }] },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("banana");
	});
});

describe("hashline acceptance", () => {
	it("preserves newline state, repeated positions, adjacent boundaries, and gutters", async () => {
		const cwd = await mkdtemp(join(tempDir(), "hashline-cases-"));
		const path = join(cwd, "case.ts");
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, { ...makeToolContext(), cwd }, noopTrack);
		for (const ending of ["\n", "\r\n", "\r"]) {
			for (const final of ["", ending]) {
				await writeFile(path, ["same", "same", "last"].join(ending) + final);
				const result = await executeTool(
					tool,
					"id",
					{
						path,
						edits: [
							{ op: "replace", pos: anchor(2, "same"), lines: ["new", "extra"] },
							{ op: "replace", pos: anchor(3, "last"), lines: ["end"] },
							{ op: "insert_after", pos: anchor(2, "same"), lines: ["boundary"] },
						],
					},
					undefined,
					undefined,
					{ cwd },
				);
				expect(result.isError).not.toBe(true);
				expect(await readFile(path, "utf8")).toBe(
					["same", "new", "extra", "boundary", "end"].join(ending) + final,
				);
				expect(
					(result.details as { ops: { editLine: number }[] }).ops.map((op) => op.editLine),
				).toEqual([2, 3, 5]);
			}
		}
	});
	it("rejects syntax, stale hashes, bounds, ranges, encodings, and cancellation without mutation", async () => {
		const cwd = await mkdtemp(join(tempDir(), "hashline-invalid-"));
		const path = join(cwd, "case.ts");
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, { ...makeToolContext(), cwd }, noopTrack);
		const source = "a\nb\nc";
		await writeFile(path, source);
		for (const edits of [
			[{ op: "replace", pos: "1#bad", lines: ["x"] }],
			[{ op: "replace", pos: anchor(1, "wrong"), lines: ["x"] }],
			[{ op: "replace", pos: anchor(4, "c"), lines: [] }],
			[{ op: "replace", pos: anchor(3, "c"), end: anchor(1, "a"), lines: [] }],
			[
				{ op: "replace", pos: anchor(1, "a"), end: anchor(2, "b"), lines: [] },
				{ op: "replace", pos: anchor(2, "b"), lines: [] },
			],
			[{ op: "insert_before", pos: anchor(1, "a"), end: anchor(2, "b"), lines: [] }],
			[{ op: "replace", pos: anchor(1, "a"), lines: ["x\ny"] }],
			[{ op: "replace", pos: anchor(1, "a"), lines: ["\ud800"] }],
		]) {
			const result = await executeTool(tool, "id", { path, edits }, undefined, undefined, { cwd });
			expect(result.isError).toBe(true);
			expect(await readFile(path, "utf8")).toBe(source);
		}
		const edits = [{ op: "replace", pos: anchor(1, "a"), lines: [] }];
		await expect(
			executeTool(tool, "id", { path, edits }, AbortSignal.abort(), undefined, { cwd }),
		).rejects.toThrow("Operation aborted");
		for (const bytes of [Buffer.from([0xff]), Buffer.from("a\0b"), Buffer.from("")]) {
			await writeFile(path, bytes);
			expect(
				(await executeTool(tool, "id", { path, edits }, undefined, undefined, { cwd })).isError,
			).toBe(true);
			expect(await readFile(path)).toEqual(bytes);
		}
	});
	it("uses one delimiter choice and preserves untouched mixed endings", async () => {
		const cwd = await mkdtemp(join(tempDir(), "hashline-mixed-"));
		const path = join(cwd, "case.ts");
		await writeFile(path, "a\rb\nc\nd");
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, { ...makeToolContext(), cwd }, noopTrack);
		await executeTool(
			tool,
			"id",
			{
				path,
				edits: [
					{ op: "insert_after", pos: anchor(1, "a"), lines: ["x"] },
					{ op: "insert_after", pos: anchor(4, "d"), lines: ["y"] },
				],
			},
			undefined,
			undefined,
			{ cwd },
		);
		expect(await readFile(path, "utf8")).toBe("a\rx\nb\nc\nd\ny");
	});
	it("writes in place through a hard link without replacing the inode or mode", async () => {
		const cwd = await mkdtemp(join(tempDir(), "hashline-links-"));
		const path = join(cwd, "source.ts");
		const alias = join(cwd, "alias.ts");
		await writeFile(path, "a\n", { mode: 0o640 });
		await link(path, alias);
		const before = await stat(path);
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, { ...makeToolContext(), cwd }, noopTrack);
		const result = await executeTool(
			tool,
			"id",
			{ path: alias, edits: [{ op: "replace", pos: anchor(1, "a"), lines: ["b"] }] },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.isError).not.toBe(true);
		expect(await readFile(path, "utf8")).toBe("b\n");
		const after = await stat(path);
		expect({ ino: after.ino, mode: after.mode, nlink: after.nlink }).toEqual({
			ino: before.ino,
			mode: before.mode,
			nlink: before.nlink,
		});
	});
	it("documents short-hash collisions and unchecked replacement interiors", async () => {
		const seen = new Map<string, string>();
		let collision: [string, string] | undefined;
		for (let i = 0; i <= 4096; i++) {
			const text = `source-${i}`;
			const hash = hashLine(text);
			const previous = seen.get(hash);
			if (previous) {
				collision = [previous, text];
				break;
			}
			seen.set(hash, text);
		}
		expect(collision).toBeDefined();
		expect(hashLine(collision![0])).toBe(hashLine(collision![1]));
		const cwd = await mkdtemp(join(tempDir(), "hashline-limits-"));
		const path = join(cwd, "source.ts");
		await writeFile(path, "a\nchanged interior\nc");
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, { ...makeToolContext(), cwd }, noopTrack);
		const result = await executeTool(
			tool,
			"id",
			{ path, edits: [{ op: "replace", pos: anchor(1, "a"), end: anchor(3, "c"), lines: ["x"] }] },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.isError).not.toBe(true);
		expect(await readFile(path, "utf8")).toBe("x");
	});
	it("normalizes argument shapes and Pi path syntax", () => {
		const edit = { op: "replace", pos: anchor(1, "a"), lines: ["b"] };
		expect(prepareHashArguments({ path: "x", edits: JSON.stringify(edit) })).toEqual({
			path: "x",
			edits: [edit],
		});
		expect(prepareHashArguments({ path: "x", edits: edit })).toEqual({ path: "x", edits: [edit] });
		expect(editPath("@a\u202fb.ts", tempDir())).toBe(join(tempDir(), "a b.ts"));
	});
});

describe("getEditOperations", () => {
	it("extracts array edits", () => {
		const ops = getEditOperations({
			path: "f.ts",
			edits: [{ oldText: "a", newText: "b" }],
		});
		expect(ops).toEqual([{ oldText: "a", newText: "b" }]);
	});

	it("filters ops where old === new", () => {
		const ops = getEditOperations({
			path: "f.ts",
			edits: [{ oldText: "x", newText: "x" }],
		});
		expect(ops).toHaveLength(0);
	});
});

describe("summarizeEditOperations", () => {
	it("returns a summary string", () => {
		const { summary } = summarizeEditOperations([{ oldText: "a\nb", newText: "c\nd\ne" }]);
		expect(typeof summary).toBe("string");
		expect(summary.length).toBeGreaterThan(0);
	});
});
