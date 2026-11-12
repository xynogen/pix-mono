import { beforeEach, describe, expect, mock, test } from "bun:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { editText, writeText } from "../src/files.ts";
import { anchor, initHashline } from "../src/hashline.ts";

const exec = await import("../src/exec.ts");
const remote = new Map<string, Buffer>();
const commands: string[] = [];
const localPaths: string[] = [];
let failRename = false;
let failPut = false;
let reads = 0;
let changed = false;
let listingOverride: string | undefined;
let failCleanup = false;
let abortOnPut: AbortController | undefined;
const runner = mock(
	async (
		_name: string,
		args: readonly string[],
		opts: { input?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
	) => {
		opts.signal?.throwIfAborted();
		const line = opts.input!.trim();
		commands.push(line);
		const parts = [...line.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) =>
			m[1]!.replace(/\\(.)/g, "$1"),
		);
		let error = "";
		let stdout = "";
		if (line.startsWith("ls ")) {
			const data = remote.get(parts[0]!);
			if (!data) error = `Can't ls: "${parts[0]}" not found`;
			else
				stdout =
					listingOverride ?? `-rw-r----- 1 user group ${data.length} Jan 1 00:00 ${parts[0]}`;
		} else if (line.startsWith("get ")) {
			reads++;
			const data = changed && reads > 1 ? Buffer.from("external\n") : remote.get(parts[0]!);
			if (!data) error = "No such file or directory";
			else {
				localPaths.push(parts[1]!);
				await writeFile(parts[1]!, data);
				await chmod(parts[1]!, 0o640);
			}
		} else if (line.startsWith("put ")) {
			localPaths.push(parts[0]!);
			if (failPut) error = "Interrupted upload";
			else remote.set(parts[1]!, await readFile(parts[0]!));
			abortOnPut?.abort();
		} else if (line.startsWith("rename ")) {
			if (failRename) error = "Rename unsupported";
			else {
				remote.set(parts[1]!, remote.get(parts[0]!)!);
				remote.delete(parts[0]!);
			}
		} else if (line.startsWith("rm ")) {
			if (failCleanup) error = "cleanup denied";
			else remote.delete(parts[0]!);
		}
		expect(args).toContain("-b");
		return {
			code: error ? 1 : 0,
			stderr: error,
			stdout,
			stdoutBytes: Buffer.alloc(0),
			truncated: false,
			timedOut: false,
		};
	},
);
mock.module("../src/exec.ts", () => ({ ...exec, runTool: runner }));
const { sftpPath, sftpQuote, withSftp } = await import("../src/sftp.ts");
const opts = { host: "alias", args: ["-P", "2222"] };

beforeEach(async () => {
	await initHashline();
	remote.clear();
	commands.length = 0;
	localPaths.length = 0;
	failRename = false;
	failPut = false;
	reads = 0;
	changed = false;
	listingOverride = undefined;
	failCleanup = false;
	abortOnPut = undefined;
	runner.mockClear();
});

describe("SFTP file backend", () => {
	test("normalizes Windows paths independently of the local OS and rejects command injection", () => {
		expect(sftpPath("C:\\Users\\User\\file.txt")).toBe("/C:/Users/User/file.txt");
		expect(sftpPath("/var/app/file")).toBe("/var/app/file");
		expect(sftpPath("-filename")).toBe("./-filename");
		expect(() => sftpPath("{a,b}")).toThrow();
		expect(sftpQuote('a [1]*?".txt')).toBe('"a [1]*?\\".txt"');
		for (const path of ["", "bad\n!command", "bad\0path", "~/file"])
			expect(() => sftpPath(path)).toThrow();
	});

	test("edits downloaded bytes with shared anchors and commits using rename", async () => {
		remote.set("/C:/app/a.txt", Buffer.from("one\r\ntwo\r\n"));
		await withSftp(opts, (files) =>
			editText(
				"/C:/app/a.txt",
				{
					path: "/C:/app/a.txt",
					edits: [{ op: "replace", pos: anchor(2, "two"), lines: ["three"] }],
				},
				files,
			),
		);
		expect(remote.get("/C:/app/a.txt")!.toString()).toBe("one\r\nthree\r\n");
		expect(commands.some((c) => c.startsWith("rename "))).toBe(true);
		expect(commands.some((c) => c.includes("sed "))).toBe(false);
		for (const path of localPaths) expect(await Bun.file(path).exists()).toBe(false);
	});

	test("failed upload or rename leaves the destination intact and cleans temporary files", async () => {
		for (const failure of ["put", "rename"]) {
			failPut = failure === "put";
			failRename = failure === "rename";
			remote.set("/a", Buffer.from("original"));
			await expect(
				withSftp(opts, (files) => writeText("/a", "replacement", files)),
			).rejects.toThrow();
			expect(remote.get("/a")!.toString()).toBe("original");
			expect([...remote.keys()]).toEqual(["/a"]);
		}
	});

	test("detects external changes between read and edit commit", async () => {
		remote.set("/a", Buffer.from("one\n"));
		changed = true;
		await expect(
			withSftp(opts, (files) =>
				editText("/a", { path: "/a", edits: [{ oldText: "one", newText: "two" }] }, files),
			),
		).rejects.toThrow("changed since read");
		expect(commands.some((c) => c.startsWith("put "))).toBe(false);
	});

	test("new empty files create remote parents and passwords stay out of argv", async () => {
		await withSftp({ ...opts, loginPassword: "private" }, (files) =>
			writeText("/C:/new/sub/a", "", files),
		);
		expect(remote.get("/C:/new/sub/a")!.length).toBe(0);
		expect(commands).toContain('-mkdir "/C:/new/sub"');
		const call = runner.mock.calls[0]!;
		expect(call[0]).toBe("sshpass");
		expect(call[1]).not.toContain("private");
		expect(call[2].env?.SSHPASS).toBe("private");
		expect(call[1].indexOf("BatchMode=no")).toBeLessThan(call[1].indexOf("-b"));
	});

	test("rejects symlinks and oversized files before downloading", async () => {
		remote.set("/a", Buffer.from("one"));
		for (const listing of [
			"lrwxrwxrwx 1 u g 3 Jan 1 00:00 a -> b",
			"-rw-r--r-- 1 u g 999999999 Jan 1 00:00 a",
		]) {
			listingOverride = listing;
			await expect(withSftp(opts, (files) => files.readFile("/a"))).rejects.toThrow();
		}
		expect(commands.some((c) => c.startsWith("get "))).toBe(false);
	});

	test("cleanup errors expose the remote temporary path and cancellation uses an independent cleanup signal", async () => {
		remote.set("/a", Buffer.from("old"));
		failRename = true;
		failCleanup = true;
		await expect(withSftp(opts, (files) => writeText("/a", "new", files))).rejects.toThrow(
			"temporary file may remain",
		);
		failRename = false;
		failCleanup = false;
		abortOnPut = new AbortController();
		await withSftp({ ...opts, signal: abortOnPut.signal }, (files) =>
			writeText("/a", "new", files),
		).catch(() => {});
		const cleanup = runner.mock.calls.at(-1)!;
		expect(cleanup[2].input).toMatch(/^rm /);
		expect(cleanup[2].signal?.aborted).toBe(false);
		expect(remote.get("/a")!.toString()).toBe("old");
	});

	test("pre-aborted operations never spawn a process", async () => {
		await expect(
			withSftp({ ...opts, signal: AbortSignal.abort() }, async () => {}),
		).rejects.toThrow();
		expect(runner).not.toHaveBeenCalled();
	});
});
