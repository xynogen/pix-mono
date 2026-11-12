import { describe, expect, test } from "bun:test";
import {
	microphoneInput,
	microphoneLabel,
	parseAvfoundationDevices,
	parseDshowDevices,
	parsePulseSources,
	parseRmsDb,
	playCommand,
	recordArgs,
} from "../src/audio.ts";
import type { HostPlatform } from "../src/platform.ts";

const linux: HostPlatform = {
	os: "linux",
	arch: "x64",
	libc: "glibc",
	wsl: false,
	termux: false,
	exe: "",
};
const mac: HostPlatform = { os: "darwin", arch: "arm64", wsl: false, termux: false, exe: "" };
const win: HostPlatform = { os: "win32", arch: "x64", wsl: false, termux: false, exe: ".exe" };

describe("microphone list", () => {
	test.each([
		["a USB mic", "alsa_input.usb-Mic", "Yeti Stereo", "Microphone - Yeti"],
		["a Bluetooth input", "bluez_input.AA", "Buds Pro", "Headset - Buds Pro"],
		["a webcam that names itself", "alsa_input.usb-cam", "Webcam X Mono", "Webcam X"],
		[
			"a surround layout",
			"alsa_input.pci-b",
			"Sound Card Analog Surround 5.1",
			"Microphone - Sound Card",
		],
		[
			"a description that already ends in its kind",
			"alsa_input.pci-c",
			"Family 17h/19h HD Audio Controller Digital Microphone",
			"Family 17h/19h HD Audio Controller Digital Microphone",
		],
		["a source with no description", "virtual_mic", "", "Microphone - virtual_mic"],
	])("labels %s", (_case, id, description, label) => {
		expect(microphoneLabel(id, description)).toBe(label);
	});

	test("reads `ffmpeg -sources pulse`, skips monitors, and names the starred default", () => {
		const out = [
			"Auto-detected sources for pulse:",
			"  alsa_output.pci.HiFi__sink.monitor [Monitor of Headphones] (none)",
			"  alsa_input.usb-Mic [Yeti Stereo] (none)",
			"* alsa_input.pci.HiFi__Mic1__source [HD Audio Controller Digital Microphone] (none)",
		].join("\n");
		expect(parsePulseSources(out)).toEqual([
			{ id: "default", label: "System default (HD Audio Controller Digital Microphone)" },
			{ id: "alsa_input.usb-Mic", label: "Microphone - Yeti" },
			{
				id: "alsa_input.pci.HiFi__Mic1__source",
				label: "HD Audio Controller Digital Microphone",
			},
		]);
		expect(parsePulseSources("Auto-detected sources for pulse:\n")).toEqual([
			{ id: "default", label: "System default" },
		]);
	});
});

describe("dshow and per-OS jobs", () => {
	test("lists dshow audio inputs and skips video and alternative names", () => {
		const stderr = [
			'[in#0 @ 0] "Logi C310 HD WebCam" (video)',
			'[in#0 @ 0]   Alternative name "@device_pnp_x"',
			'[in#0 @ 0] "Microphone (Logi C310 HD WebCam)" (audio)',
			'[in#0 @ 0]   Alternative name "@device_cm_y"',
			'[in#0 @ 0] "Headset (Nokia E1200 ANC)" (audio)',
		].join("\n");
		expect(parseDshowDevices(stderr)).toEqual([
			{ id: "default", label: "System default (Microphone (Logi C310 HD WebCam))" },
			{ id: "Microphone (Logi C310 HD WebCam)", label: "Microphone (Logi C310 HD WebCam)" },
			{ id: "Headset (Nokia E1200 ANC)", label: "Headset (Nokia E1200 ANC)" },
		]);
		expect(parseDshowDevices("")).toEqual([{ id: "default", label: "System default" }]);
	});

	test("lists avfoundation audio inputs and skips the video section", () => {
		const stderr = [
			"[AVFoundation indev @ 0x1] AVFoundation video devices:",
			"[AVFoundation indev @ 0x1] [0] FaceTime HD Camera  [uid:0x1]",
			"[AVFoundation indev @ 0x1] AVFoundation audio devices:",
			"[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone  [uid:BuiltInMicrophoneDevice]",
			"[AVFoundation indev @ 0x1] [1] AirPods Pro",
		].join("\n");
		expect(parseAvfoundationDevices(stderr)).toEqual([
			{ id: "default", label: "System default" },
			{ id: "MacBook Pro Microphone", label: "MacBook Pro Microphone" },
			{ id: "AirPods Pro", label: "AirPods Pro" },
		]);
	});

	test("maps a device to the ffmpeg input of each OS", () => {
		expect(microphoneInput("default", { host: linux })).toEqual(["-f", "pulse", "-i", "default"]);
		expect(microphoneInput("default", { host: mac })).toEqual([
			"-f",
			"avfoundation",
			"-i",
			":default",
		]);
		expect(microphoneInput("Headset (X)", { host: win })).toEqual([
			"-f",
			"dshow",
			"-i",
			"audio=Headset (X)",
		]);
		expect(() => microphoneInput("default", { host: { ...linux, os: "android" } })).toThrow(
			/not supported on android/,
		);
	});

	test("records mono 16 kHz with a level meter, to a file or to null", () => {
		const input = ["-f", "pulse", "-i", "default"];
		const tail = ["-ac", "1", "-ar", "16000", "-af", expect.stringContaining("astats")];
		expect(recordArgs(input, "/tmp/a.wav")).toEqual([
			"-hide_banner",
			"-loglevel",
			"info",
			...input,
			...tail,
			"-y",
			"/tmp/a.wav",
		]);
		expect(recordArgs(input).slice(-3)).toEqual(["-f", "null", "-"]);
		expect(parseRmsDb("lavfi.astats.Overall.RMS_level=-31.7\n")).toBe(-31.7);
		expect(parseRmsDb("lavfi.astats.Overall.RMS_level=-inf\n")).toBeUndefined();
	});

	test("plays with ffmpeg on Linux and macOS, MediaPlayer on Windows", () => {
		expect(playCommand("/tmp/a.mp3", linux)).toEqual([
			"ffmpeg",
			"-hide_banner",
			"-nostdin",
			"-loglevel",
			"error",
			"-re",
			"-i",
			"/tmp/a.mp3",
			"-f",
			"pulse",
			"pix",
		]);
		expect(playCommand("/tmp/a.mp3", mac)?.slice(-4)).toEqual([
			"/tmp/a.mp3",
			"-f",
			"audiotoolbox",
			"-",
		]);
		const [name, ...args] = playCommand("C:\\Temp\\it's.mp3", win) ?? [];
		expect(name).toBe("powershell");
		expect(args.at(-1)).toContain("[uri]'C:\\Temp\\it''s.mp3'");
		expect(playCommand("/tmp/a.mp3", { ...linux, os: "android" })).toBeUndefined();
	});
});
