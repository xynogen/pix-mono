import { describe, expect, test } from "bun:test";
import { hostPlatform } from "../src/platform.ts";

const none = () => undefined;

describe("hostPlatform", () => {
	test("windows", () => {
		expect(hostPlatform({ platform: "win32", arch: "x64", env: {} })).toEqual({
			os: "win32",
			arch: "x64",
			wsl: false,
			termux: false,
			exe: ".exe",
		});
	});

	test("darwin arm64", () => {
		expect(hostPlatform({ platform: "darwin", arch: "arm64", env: {} })).toMatchObject({
			os: "darwin",
			arch: "arm64",
			exe: "",
		});
	});

	test("linux glibc vs musl", () => {
		const glibc = hostPlatform({
			platform: "linux",
			arch: "x64",
			env: {},
			glibcVersion: () => "2.39",
			procVersion: () => "Linux version 6.8 (gcc)",
		});
		expect(glibc).toMatchObject({ os: "linux", libc: "glibc", wsl: false });
		const musl = hostPlatform({
			platform: "linux",
			arch: "arm64",
			env: {},
			glibcVersion: none,
			procVersion: none,
		});
		expect(musl).toMatchObject({ os: "linux", arch: "arm64", libc: "musl" });
	});

	test("wsl from env or /proc/version", () => {
		const base = { platform: "linux" as const, arch: "x64", glibcVersion: () => "2.39" };
		expect(
			hostPlatform({ ...base, env: { WSL_DISTRO_NAME: "Ubuntu" }, procVersion: none }).wsl,
		).toBe(true);
		expect(
			hostPlatform({ ...base, env: {}, procVersion: () => "Linux 5.15-microsoft-standard-WSL2" })
				.wsl,
		).toBe(true);
	});

	test("termux maps to android", () => {
		expect(
			hostPlatform({ platform: "linux", arch: "arm64", env: { TERMUX_VERSION: "0.118" } }),
		).toMatchObject({ os: "android", termux: true });
	});
});
