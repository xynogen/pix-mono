import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EditOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import { editText, readText, writeText } from "./files.ts";
import { anchor, initHashline } from "./hashline.ts";
import { tempDir } from "./paths.ts";

beforeAll(initHashline);

describe("shared file operations", () => {
	test("local write creates parents and read/edit preserve BOM and mixed endings", async () => {
		const root = await mkdtemp(join(tempDir(), "pix-files-"));
		try {
			const path = join(root, "nested", "a.ts");
			await writeText(path, "\uFEFFa\r\nb\n");
			const result = readText(await readFile(path));
			expect(result.modelContent).toBe(`${anchor(1, "a")}|a\n${anchor(2, "b")}|b`);
			await editText(path, { path, edits: [{ op: "replace", pos: anchor(2, "b"), lines: ["c"] }] });
			expect(await readFile(path, "utf8")).toBe("\uFEFFa\r\nc\r\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("remote backend gets the same exact/hash edits and remote parent path", async () => {
		let content = Buffer.from("one\r\ntwo\r\n");
		const directories: string[] = [];
		const files: EditOperations & WriteOperations = {
			access: async () => {},
			readFile: async () => content,
			writeFile: async (_path, text) => {
				content = Buffer.from(text);
			},
			mkdir: async (path) => {
				directories.push(path);
			},
		};
		await editText(
			"/C:/app/a",
			{ path: "/C:/app/a", edits: [{ oldText: "two", newText: "three" }] },
			files,
		);
		expect(content.toString()).toBe("one\r\nthree\r\n");
		await writeText("/C:/app/a", "", files);
		expect(directories).toEqual(["/C:/app"]);
		expect(content.length).toBe(0);
	});

	test("stale or invalid edits and cancellation never write", async () => {
		let writes = 0;
		const files: EditOperations = {
			access: async () => {},
			readFile: async () => Buffer.from("one\n"),
			writeFile: async () => {
				writes++;
			},
		};
		await expect(
			editText(
				"a",
				{ path: "a", edits: [{ op: "replace", pos: anchor(1, "wrong"), lines: ["bad"] }] },
				files,
			),
		).rejects.toThrow("Stale anchor");
		await expect(
			editText(
				"a",
				{ path: "a", edits: [{ oldText: "one", newText: "two" }] },
				files,
				AbortSignal.abort(),
			),
		).rejects.toThrow("Operation aborted");
		expect(writes).toBe(0);
	});

	test("read limits include anchor bytes and never change pagination anchors", () => {
		const bytes = Buffer.from(Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n"));
		const first = readText(bytes, 50, 3);
		expect(first.modelContent.split("\n")[0]).toBe(`${anchor(50, "line 49")}|line 49`);
		expect(first.notice).toContain("offset=53");
		expect(readText(bytes, 1, 2500).lineCount).toBe(2000);
		expect(() => readText(bytes, 0)).toThrow("positive integers");
	});
});
