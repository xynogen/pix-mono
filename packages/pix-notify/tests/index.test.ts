import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { tempDir } from "@xynogen/pix-runtime/paths";
import type { HostPlatform } from "@xynogen/pix-runtime/platform";
import { bindNotify, playArgs, resolveSound, systemSounds } from "../src/index.ts";

const linux: HostPlatform = {
	os: "linux",
	arch: "x64",
	libc: "glibc",
	wsl: false,
	termux: false,
	exe: "",
};

// A fake freedesktop sound theme under XDG_DATA_DIRS. That list is ":"-separated, so drop a
// Windows drive letter (C:) or the split cuts the path. Driveless paths stay on the current drive.
const share = mkdtempSync(join(tempDir(), "pix-notify-")).replace(/^[A-Za-z]:/, "");
const stereo = join(share, "sounds", "freedesktop", "stereo");
mkdirSync(stereo, { recursive: true });
for (const f of [
	"bell.oga",
	"message-new-instant.oga",
	"audio-channel-front-center.oga",
	"readme.txt",
])
	writeFileSync(join(stereo, f), "");
const env = { XDG_DATA_DIRS: share };

function setup(
	extraEnv: NodeJS.ProcessEnv,
	opts: { missing?: string[]; herdrIntegration?: boolean; enabled?: boolean } = {},
) {
	const events = createEventBus();
	const calls: string[][] = [];
	const bridged: unknown[] = [];
	events.on("herdr:blocked", (data) => bridged.push(data));
	bindNotify(events, {
		env: { ...env, ...extraEnv },
		host: linux,
		herdrIntegration: opts.herdrIntegration ?? false,
		settings: () => ({ enabled: opts.enabled ?? true, sound: "auto" }),
		start: (name, args) => {
			if (opts.missing?.includes(name)) throw new Error(`${name} missing`);
			calls.push([name, ...args]);
		},
	});
	const emit = (state: "working" | "blocked" | "idle", message?: string) =>
		events.emit("pix:agent-state", { state, message, activities: 0, blocks: 0 });
	return { calls, bridged, emit };
}

describe("pix-notify", () => {
	test("herdr integration installed: block forwarded as herdr:blocked, no own sound", () => {
		const { calls, bridged, emit } = setup({ HERDR_ENV: "1" }, { herdrIntegration: true });
		emit("working");
		emit("blocked", "Approve?");
		emit("blocked", "Approve?");
		emit("working");
		emit("blocked");
		emit("idle");
		expect(bridged).toEqual([
			{ active: true, label: "Approve?" },
			{ active: false },
			{ active: true, label: "Pi needs your attention" },
			{ active: false },
		]);
		expect(calls).toEqual([]);
	});

	test("herdr pane without integration: one herdr notification per entry into blocked", () => {
		const { calls, emit } = setup({ HERDR_ENV: "1" });
		emit("blocked", "Approve?");
		emit("blocked", "Approve?");
		emit("idle");
		emit("blocked");
		expect(calls).toEqual([
			["herdr", "notification", "show", "Approve?", "--sound", "request"],
			["herdr", "notification", "show", "Pi needs your attention", "--sound", "request"],
		]);
	});

	test("outside herdr, or herdr missing: preferred system sound via the OS player", () => {
		for (const extra of [{}, { HERDR_ENV: "1" }]) {
			const { calls, emit } = setup(extra, { missing: ["herdr"] });
			emit("blocked");
			expect(calls).toEqual([["paplay", join(stereo, "message-new-instant.oga")]]);
		}
	});

	test("notify off: silent", () => {
		const { calls, emit } = setup({}, { enabled: false });
		emit("blocked");
		expect(calls).toEqual([]);
	});

	test("sound resolution and per-OS players", () => {
		const sounds = systemSounds(linux, env);
		// Only notification sounds, in preference order; test tones and non-audio drop out.
		expect([...sounds.keys()]).toEqual(["message-new-instant", "bell"]);
		expect(resolveSound("bell", sounds)).toBe(join(stereo, "bell.oga"));
		expect(resolveSound("/x/my.wav", sounds)).toBe("/x/my.wav");
		expect(playArgs("/s.aiff", { ...linux, os: "darwin" })).toEqual(["afplay", "/s.aiff"]);
		expect(playArgs("C:\\it's.wav", { ...linux, os: "win32" })?.at(-1)).toBe(
			"(New-Object Media.SoundPlayer 'C:\\it''s.wav').PlaySync()",
		);
		expect(playArgs("/s.oga", { ...linux, os: "android" })).toBeUndefined();
	});
});
