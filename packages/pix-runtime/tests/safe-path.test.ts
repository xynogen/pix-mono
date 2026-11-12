import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "../src/paths.ts";
import type { HostPlatform } from "../src/platform.ts";
import { sensitivePrefixes, validateOutputPath } from "../src/safe-path.ts";

const isWin = process.platform === "win32";
const linux: HostPlatform = {
	os: "linux",
	arch: "x64",
	libc: "glibc",
	wsl: false,
	termux: false,
	exe: "",
};
const win: HostPlatform = { os: "win32", arch: "x64", wsl: false, termux: false, exe: ".exe" };
const linuxEnv = { HOME: "/home/u" };
const winEnv = {
	USERPROFILE: "C:\\Users\\u",
	SystemRoot: "C:\\Windows",
	ProgramFiles: "C:\\Program Files",
	APPDATA: "C:\\Users\\u\\AppData\\Roaming",
};

/** Directory link without admin rights: a junction on Windows, a symlink elsewhere. */
function linkDir(target: string, path: string): void {
	symlinkSync(target, path, isWin ? "junction" : "dir");
}

describe("sensitive prefixes per OS", () => {
	it.each([
		["/etc/passwd", linux, linuxEnv],
		["/proc/cpuinfo", linux, linuxEnv],
		["/home/u/.ssh/authorized_keys", linux, linuxEnv],
		["/home/u/.config/gh/hosts.yml", linux, linuxEnv],
		["C:\\Windows\\System32\\x.dll", win, winEnv],
		["c:\\windows\\x.txt", win, winEnv],
		["C:\\Program Files\\App\\x.exe", win, winEnv],
		["C:\\Users\\u\\.ssh\\config", win, winEnv],
		["C:\\Users\\u\\AppData\\Roaming\\GitHub CLI\\hosts.yml", win, winEnv],
	])("rejects %s", async (bad, host, env) => {
		const result = await validateOutputPath(bad, { host, env });
		expect(result).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/^refusing to write under /),
		});
	});

	it.each([
		"\\\\?\\C:\\Windows\\x.txt",
		"\\\\.\\C:\\Users\\u\\.ssh\\config",
		"//?/C:/Windows/x.txt",
		"\\??\\C:\\Windows\\x.txt",
	])("rejects Windows namespace path %s", async (bad) => {
		const result = await validateOutputPath(bad, { host: win, env: winEnv });
		expect(result).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/^refusing a Windows device or namespace path: /),
		});
	});

	it("matches whole path segments, not a string prefix", () => {
		// "/etcetera" is not under "/etc".
		const prefixes = sensitivePrefixes({ host: linux, env: linuxEnv });
		expect(prefixes).toContain("/etc");
		return expect(
			validateOutputPath("/etcetera/x", { host: linux, env: linuxEnv }),
		).resolves.not.toMatchObject({
			reason: expect.stringMatching(/refusing/),
		});
	});
});

describe("validateOutputPath on this host", () => {
	const root = mkdtempSync(join(tempDir(), "pix-safe-path-"));

	it("accepts fresh, deep, and existing-file paths", async () => {
		writeFileSync(join(root, "exists.txt"), "old");
		for (const path of [
			join(root, "fresh.txt"),
			join(root, "a", "b", "deep.txt"),
			join(root, "exists.txt"),
		])
			expect(await validateOutputPath(path)).toEqual({ ok: true, path });
	});

	it.each([
		["a null byte", () => join(root, "x\0y.txt"), /null byte/],
		[
			"an existing directory",
			() => {
				mkdirSync(join(root, "dir"), { recursive: true });
				return join(root, "dir");
			},
			/existing directory/,
		],
		[
			"no existing ancestor",
			() => (isWin ? "Q:\\no-such-root-xyz\\x.txt" : "/no-such-root-xyz/a/x.txt"),
			/no existing ancestor/,
		],
	])("rejects %s", async (_case, path, reason) => {
		expect(await validateOutputPath(path())).toMatchObject({
			ok: false,
			reason: expect.stringMatching(reason),
		});
	});

	it("rejects a linked parent directory", async () => {
		mkdirSync(join(root, "real-sub"));
		linkDir(join(root, "real-sub"), join(root, "fake-parent"));
		expect(await validateOutputPath(join(root, "fake-parent", "x.txt"))).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/parent is a symlink/),
		});
	});

	it("rejects a linked target", async () => {
		mkdirSync(join(root, "real-dir"));
		linkDir(join(root, "real-dir"), join(root, "link-target"));
		expect(await validateOutputPath(join(root, "link-target"))).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/target is a symlink/),
		});
	});

	// Windows W_OK reads only the read-only attribute, which does not apply to a directory.
	it.skipIf(isWin)("rejects a parent that is not writable", async () => {
		const ro = join(root, "ro");
		mkdirSync(ro);
		await chmod(ro, 0o555);
		try {
			expect(await validateOutputPath(join(ro, "x.txt"))).toMatchObject({
				ok: false,
				reason: expect.stringMatching(/no writable ancestor/),
			});
		} finally {
			await chmod(ro, 0o755);
		}
	});

	it("cleanup", () => rmSync(root, { recursive: true, force: true }));
});
