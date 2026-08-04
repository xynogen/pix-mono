/**
 * clipboard-image.test.ts — pure-logic tests for the clipboard-image reader.
 *
 * The spawn-based reads (wl-paste/xclip/powershell) need a live clipboard and
 * are exercised manually; here we cover the platform/env gating and the
 * mime→extension mapping that decides the temp-file suffix.
 */

import { describe, expect, test } from "bun:test";
import { extForMime, isWaylandSession, readClipboardImageToFile } from "./clipboard-image.ts";

describe("extForMime", () => {
	test("maps supported mime types to extensions", () => {
		expect(extForMime("image/png")).toBe("png");
		expect(extForMime("image/jpeg")).toBe("jpg");
		expect(extForMime("image/webp")).toBe("webp");
		expect(extForMime("image/gif")).toBe("gif");
	});

	test("ignores parameters after the base type", () => {
		expect(extForMime("image/png; charset=binary")).toBe("png");
		expect(extForMime("IMAGE/JPEG")).toBe("jpg");
	});

	test("falls back to png for unknown types", () => {
		expect(extForMime("image/bmp")).toBe("png");
		expect(extForMime("application/octet-stream")).toBe("png");
	});
});

describe("isWaylandSession", () => {
	test("true when WAYLAND_DISPLAY is set", () => {
		expect(isWaylandSession({ WAYLAND_DISPLAY: "wayland-1" })).toBe(true);
	});

	test("true when XDG_SESSION_TYPE is wayland", () => {
		expect(isWaylandSession({ XDG_SESSION_TYPE: "wayland" })).toBe(true);
	});

	test("false for a bare X11 env", () => {
		expect(isWaylandSession({ DISPLAY: ":0", XDG_SESSION_TYPE: "x11" })).toBe(false);
	});
});

describe("readClipboardImageToFile gating", () => {
	test("returns null on non-linux platforms without spawning", () => {
		expect(readClipboardImageToFile({}, "darwin")).toBeNull();
		expect(readClipboardImageToFile({}, "win32")).toBeNull();
	});

	test("returns null under Termux", () => {
		expect(readClipboardImageToFile({ TERMUX_VERSION: "0.118" }, "linux")).toBeNull();
	});
});
