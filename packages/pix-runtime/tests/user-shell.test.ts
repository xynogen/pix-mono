import { describe, expect, test } from "bun:test";
import type { HostPlatform } from "../src/platform.ts";
import { PLAIN_TEXT_PREAMBLE, userShell } from "../src/user-shell.ts";

const linux: HostPlatform = {
	os: "linux",
	arch: "x64",
	libc: "glibc",
	wsl: false,
	termux: false,
	exe: "",
};
const darwin: HostPlatform = { ...linux, os: "darwin", libc: undefined };
const win: HostPlatform = { ...linux, os: "win32", libc: undefined, exe: ".exe" };
const home = "/home/u ser";

describe("userShell", () => {
	test("win32 always uses PowerShell with plain-text output", () => {
		for (const shell of [
			undefined,
			"/usr/bin/bash",
			"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
		]) {
			const s = userShell({ host: win, shell, home });
			expect(s?.kind).toBe("powershell");
			expect(s?.wrap("ls")).toBe(`${PLAIN_TEXT_PREAMBLE}ls`);
		}
	});

	test("unset, empty, or bash SHELL keeps the Pi default on POSIX", () => {
		expect(userShell({ host: linux, shell: undefined, home })).toBeUndefined();
		expect(userShell({ host: linux, shell: "", home })).toBeUndefined();
		expect(userShell({ host: darwin, shell: "/bin/bash", home })).toBeUndefined();
	});

	test("zsh sources a quoted .zshrc and evals the quoted command", () => {
		for (const host of [linux, darwin]) {
			const s = userShell({ host, shell: "/bin/zsh", home });
			expect(s).toMatchObject({ kind: "posix", shellPath: "/bin/zsh" });
			expect(s?.wrap("echo 'hi'")).toBe(
				`. '/home/u ser/.zshrc' 2>/dev/null; eval 'echo '\\''hi'\\'''`,
			);
		}
	});

	test("other POSIX shells redirect without wrapping", () => {
		const s = userShell({ host: linux, shell: "/usr/bin/fish", home });
		expect(s).toMatchObject({ kind: "posix", shellPath: "/usr/bin/fish" });
		expect(s?.wrap("ls -la")).toBe("ls -la");
	});
});
