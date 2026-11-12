import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { extForMime, pickPreferredMime, readClipboardImage, username } from "../src/os.ts";
import { tempDir } from "../src/paths.ts";
import type { HostPlatform } from "../src/platform.ts";

const isWin = process.platform === "win32";
const linux: HostPlatform = {
	os: "linux",
	arch: "x64",
	libc: "glibc",
	wsl: false,
	termux: false,
	exe: "",
};

test("username uses the native account, strips controls, and tolerates missing OS records", () => {
	expect(username()).toBe(os.userInfo().username.trim());
	const info = os.userInfo();
	const lookup = spyOn(os, "userInfo");
	try {
		lookup.mockReturnValue({ ...info, username: "  alice\x1b\n  " });
		expect(username()).toBe("alice");
		lookup.mockReturnValue({ ...info, username: "   " });
		expect(username()).toBeUndefined();
		lookup.mockImplementation(() => {
			throw new Error("No user record");
		});
		expect(username()).toBeUndefined();
	} finally {
		lookup.mockRestore();
	}
});

describe("clipboard helpers", () => {
	test("mime preference and extensions", () => {
		expect(pickPreferredMime(["text/plain", "image/jpeg", "image/png"])).toBe("image/png");
		expect(pickPreferredMime(["image/bmp"])).toBe("image/bmp");
		expect(pickPreferredMime(["text/plain"])).toBeNull();
		expect(extForMime("image/jpeg; x=1")).toBe("jpg");
		expect(extForMime("image/bmp")).toBe("png");
	});

	test("macOS and Termux have no bridge", () => {
		expect(readClipboardImage({ host: { ...linux, os: "darwin" } })).toBeNull();
		expect(readClipboardImage({ host: { ...linux, os: "android", termux: true } })).toBeNull();
	});

	test("no clipboard tool installed → null, no throw", () => {
		const empty = mkdtempSync(join(tempDir(), "pix-os-"));
		const env = { PATH: empty, PI_CODING_AGENT_DIR: join(empty, "agent") };
		expect(readClipboardImage({ env, host: linux })).toBeNull();
	});

	test.skipIf(isWin)("Wayland reads through wl-paste found via the resolver", () => {
		const root = mkdtempSync(join(tempDir(), "pix-os-"));
		const bin = join(root, "agent", "bin");
		mkdirSync(bin, { recursive: true });
		const tool = join(bin, "wl-paste");
		writeFileSync(
			tool,
			'#!/bin/sh\nif [ "$1" = "--list-types" ]; then echo image/png; else printf PNGDATA; fi\n',
		);
		chmodSync(tool, 0o755);
		const env = {
			PATH: "/usr/bin:/bin",
			PI_CODING_AGENT_DIR: join(root, "agent"),
			WAYLAND_DISPLAY: "w-0",
		};
		const img = readClipboardImage({ env, host: linux });
		expect(img?.mimeType).toBe("image/png");
		expect(img?.bytes.toString()).toBe("PNGDATA");
	});

	test.skipIf(isWin)("WSL starts powershell from / (long UNC cwd breaks Windows programs)", () => {
		const root = mkdtempSync(join(tempDir(), "pix-os-"));
		const bin = join(root, "agent", "bin");
		mkdirSync(bin, { recursive: true });
		const target = join(root, "target");
		const fake = (name: string, body: string) => {
			writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
			chmodSync(join(bin, name), 0o755);
		};
		fake("wslpath", `echo "$2" > '${target}'; echo "$2"`);
		// Writes the image only when started from /, like Windows from a short cwd.
		fake(
			"powershell",
			`[ "$PWD" = / ] && printf PNGDATA > "$(cat '${target}')" && echo ok || echo empty`,
		);
		const env = { PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: join(root, "agent") };
		const img = readClipboardImage({ env, host: { ...linux, wsl: true } });
		expect(img?.bytes.toString()).toBe("PNGDATA");
	});
});
