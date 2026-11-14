/**
 * audio.ts — microphones, recording and playback, one job per function.
 *
 * Packages ask for the job ("list microphones", "record", "play this file") and
 * never see a program name or an OS branch. ffmpeg does every job it can:
 * PulseAudio/PipeWire on Linux, AVFoundation/AudioToolbox on macOS, DirectShow
 * on Windows. ffmpeg has no audio output on Windows, so playback there uses the
 * built-in PowerShell MediaPlayer. No other audio binary exists.
 */

import { join } from "node:path";
import {
	BinaryMissingError,
	type EnsureOptions,
	ensureTool,
	lookupTool,
	resolveTool,
	type ToolStatus,
} from "@xynogen/pix-runtime/binaries";
import { randomUUID } from "@xynogen/pix-runtime/crypto";
import { runBinary, runBinarySync, spawnBinary } from "@xynogen/pix-runtime/exec";
import type { OsOptions } from "@xynogen/pix-runtime/os";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { currentPlatform, type HostPlatform } from "@xynogen/pix-runtime/platform";

export interface Microphone {
	/** Device id for {@link startRecording}. "default" follows the system default. */
	id: string;
	/** Readable name, e.g. "Headset - Nokia E1200 ANC". */
	label: string;
}

const SYSTEM_DEFAULT: Microphone = { id: "default", label: "System default" };

/** The first entry names the system default input when the OS reports one. */
function withDefault(inputs: Microphone[], system?: string): Microphone[] {
	return [
		{ id: "default", label: system ? `System default (${system})` : "System default" },
		...inputs,
	];
}

// ── Device lists (ffmpeg output parsers) ────────────────────────────────────

/** "Built-in Audio Analog Stereo" → "Built-in Audio". The channel layout is noise here. */
function product(description: string): string {
	return description.replace(/\s+(Analog|Digital)?\s*(Mono|Stereo|Surround[\s\d.]*)$/i, "").trim();
}

/**
 * Readable label: "<kind> - <product>", like a desktop sound menu.
 * ponytail: ffmpeg gives only the name and description, not the form factor or
 * port, so the kind is "Headset" for Bluetooth and "Microphone" otherwise.
 */
export function microphoneLabel(id: string, description: string): string {
	const name = product(description || id);
	// "... Digital Microphone" already names its kind. Skip the prefix.
	if (/microphone|headset|webcam|\bmic\b/i.test(name)) return name;
	return `${id.startsWith("bluez_") ? "Headset" : "Microphone"} - ${name}`;
}

/**
 * Linux: `ffmpeg -sources pulse` (stdout), without output monitors.
 * Rows look like `* <name> [<description>] (none)`. `*` marks the system default.
 */
export function parsePulseSources(output: string): Microphone[] {
	let system: string | undefined;
	const inputs: Microphone[] = [];
	for (const [, star, id = "", description = ""] of output.matchAll(/^(\*)?\s*(\S+) \[(.*)\]/gm)) {
		// An output monitor records what plays, not a microphone.
		if (id.endsWith(".monitor")) continue;
		const mic = { id, label: microphoneLabel(id, description) };
		if (star) system = mic.label;
		inputs.push(mic);
	}
	return withDefault(inputs, system);
}

/** Windows: `ffmpeg -list_devices true -f dshow -i dummy` (stderr). */
export function parseDshowDevices(output: string): Microphone[] {
	const names = [...output.matchAll(/"([^"]+)" \(audio\)/g)].map((m) => m[1] as string);
	return withDefault(
		names.map((name) => ({ id: name, label: name })),
		names[0],
	);
}

/** macOS: `ffmpeg -f avfoundation -list_devices true -i ""` (stderr), audio section only. */
export function parseAvfoundationDevices(output: string): Microphone[] {
	const audio = output.split(/AVFoundation audio devices:/)[1] ?? "";
	const names = [...audio.matchAll(/\] \[\d+\] (.+?)(?:\s+\[uid:.*)?$/gm)].map((m) =>
		(m[1] as string).trim(),
	);
	return withDefault(names.map((name) => ({ id: name, label: name })));
}

const LIST: Partial<Record<HostPlatform["os"], string[]>> = {
	linux: ["-hide_banner", "-nostdin", "-sources", "pulse"],
	win32: ["-hide_banner", "-nostdin", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
	darwin: ["-hide_banner", "-nostdin", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
};

/**
 * Microphones for a picker. The first entry is always "default". Never
 * downloads ffmpeg: without it, only the default shows.
 */
export async function listMicrophones(opts: OsOptions = {}): Promise<Microphone[]> {
	const host = opts.host ?? currentPlatform();
	const args = LIST[host.os];
	if (!args || !resolveTool("ffmpeg", { ...opts, host })) return [SYSTEM_DEFAULT];
	const r = await runBinary("ffmpeg", args, { env: opts.env, host, timeoutMs: 5000 });
	// -sources prints to stdout. The dshow and avfoundation lists exit 1 and print to stderr.
	if (host.os === "linux") return r.code === 0 ? parsePulseSources(r.stdout) : [SYSTEM_DEFAULT];
	return host.os === "win32" ? parseDshowDevices(r.stderr) : parseAvfoundationDevices(r.stderr);
}

// ── Recording ───────────────────────────────────────────────────────────────

/**
 * ffmpeg input args (`-f … -i …`) that record `device`. Sync, so a recording
 * still starts on the keypress. dshow has no default device, so on Windows
 * "default" maps to the first audio input (one ~0.3 s device scan).
 */
export function microphoneInput(device: string, opts: OsOptions = {}): string[] {
	const host = opts.host ?? currentPlatform();
	if (host.os === "linux") return ["-f", "pulse", "-i", device];
	// avfoundation takes "<video>:<audio>". An empty video part records audio only.
	if (host.os === "darwin") return ["-f", "avfoundation", "-i", `:${device}`];
	if (host.os !== "win32") throw new Error(`microphone recording is not supported on ${host.os}`);
	let name = device;
	if (name === "default") {
		const r = runBinarySync("ffmpeg", LIST.win32 ?? [], { env: opts.env, host, timeoutMs: 5000 });
		name = parseDshowDevices(r.stderr)[1]?.id ?? "";
		if (!name) throw new Error("no microphone found (ffmpeg dshow lists no audio input)");
	}
	return ["-f", "dshow", "-i", `audio=${name}`];
}

const LEVEL_FILTER = "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level";

/** Mono 16 kHz wav with a per-frame RMS level on stderr. No `output` means meter only. */
export function recordArgs(input: readonly string[], output?: string): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"info",
		...input,
		"-ac",
		"1",
		"-ar",
		"16000",
		"-af",
		LEVEL_FILTER,
		...(output ? ["-y", output] : ["-f", "null", "-"]),
	];
}

/** The latest RMS level in dB from ffmpeg's log, or undefined for silence (-inf). */
export function parseRmsDb(output: string): number | undefined {
	const matches = [
		...output.matchAll(/(?:RMS level dB:\s*|lavfi\.astats\.Overall\.RMS_level=)(-?\d+(?:\.\d+)?)/g),
	];
	const value = matches.at(-1)?.[1];
	return value === undefined ? undefined : Number(value);
}

export interface RecordOptions extends OsOptions {
	/** Input level in dB, about once per audio frame. */
	onLevel?: (db: number) => void;
	/** ffmpeg stopped before `stop()`, for example on a bad device. */
	onExit?: (error: Error) => void;
	/** Download progress when ffmpeg is missing. */
	onStatus?: (s: ToolStatus) => void;
	/** Meter only: stream the level and write nothing to disk. */
	meterOnly?: boolean;
}

export interface Recording {
	/** The wav file. Empty for a meter-only session. */
	path: string;
	/** Stop, wait for the file to close, and give the last level in dB. */
	stop(): Promise<number | undefined>;
}

/**
 * Recording starts on a keypress and must not block. A missing but
 * downloadable ffmpeg starts a visible background download, and this call
 * throws and asks the user to try again when the download ends.
 */
function requireFfmpeg(purpose: string, opts: OsOptions & Pick<EnsureOptions, "onStatus">): void {
	if (resolveTool("ffmpeg", opts)) return;
	const hit = lookupTool("ffmpeg", opts);
	if (hit.state === "missing" && hit.downloadable) {
		void ensureTool("ffmpeg", opts).catch(() => undefined);
		throw new Error(
			`${purpose} needs ffmpeg — downloading it now (~120 MB); try again when it finishes.`,
		);
	}
	throw new BinaryMissingError("ffmpeg", hit.state, hit.hint, `${purpose} needs ffmpeg`);
}

/** Keep the end of the ffmpeg log for the error message. The level meter writes a line per frame. */
const STDERR_TAIL = 4096;

/** Record `device` to a temp wav, or only meter it with `meterOnly`. Call `stop()` to end. */
export function startRecording(device: string, opts: RecordOptions = {}): Recording {
	requireFfmpeg(opts.meterOnly ? "The microphone test" : "Microphone recording", opts);
	const path = opts.meterOnly ? "" : join(tempDir(), `pix-stt-${randomUUID()}.wav`);
	const child = spawnBinary(
		"ffmpeg",
		recordArgs(microphoneInput(device, opts), path || undefined),
		{
			env: opts.env,
			host: opts.host,
			stdio: ["pipe", "ignore", "pipe"],
		},
	);
	let stderr = "";
	let lastLevel: number | undefined;
	child.stderr.on("data", (data) => {
		const text = String(data);
		stderr = (stderr + text).slice(-STDERR_TAIL);
		const level = parseRmsDb(text);
		if (level === undefined) return;
		lastLevel = level;
		opts.onLevel?.(level);
	});
	let stopping = false;
	const exit = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(stderr.trim() || `ffmpeg exited ${code}`)),
		);
	});
	exit.then(
		() =>
			stopping ? undefined : opts.onExit?.(new Error("ffmpeg stopped before the recording ended")),
		(error: Error) => (stopping ? undefined : opts.onExit?.(error)),
	);
	// An exited ffmpeg closes stdin. A late write must not crash Pi with EPIPE.
	child.stdin.on("error", () => undefined);
	return {
		path,
		async stop() {
			stopping = true;
			if (child.exitCode === null && child.signalCode === null) {
				// "q" makes ffmpeg finish the wav header. A kill would leave a broken file.
				child.stdin.write("q");
				child.stdin.end();
			}
			await exit.catch((error) => {
				if (!opts.meterOnly) throw error;
			});
			return lastLevel;
		},
	};
}

// ── Playback ────────────────────────────────────────────────────────────────

/**
 * Windows: WPF MediaPlayer plays mp3/wav with no extra install.
 * ponytail: waits NaturalDuration + 200 ms. If the end cuts off, raise the pad.
 */
function mediaPlayerScript(path: string): string {
	return [
		"Add-Type -AssemblyName PresentationCore",
		"$p = New-Object System.Windows.Media.MediaPlayer",
		`$p.Open([uri]'${path.replace(/'/g, "''")}')`,
		"for ($i = 0; -not $p.NaturalDuration.HasTimeSpan -and $i -lt 200; $i++) { Start-Sleep -Milliseconds 50 }",
		"if (-not $p.NaturalDuration.HasTimeSpan) { exit 1 }",
		"$p.Play()",
		"Start-Sleep -Milliseconds ($p.NaturalDuration.TimeSpan.TotalMilliseconds + 200)",
		"$p.Close()",
	].join("; ");
}

/** `[program, ...args]` that plays `path` once on `host`, or undefined when the OS has no player. */
export function playCommand(path: string, host: HostPlatform): string[] | undefined {
	// -re sends samples at the real rate, so ffmpeg exits when the sound ends.
	const ffmpeg = ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-re", "-i", path];
	if (host.os === "linux") return [...ffmpeg, "-f", "pulse", "pix"];
	if (host.os === "darwin") return [...ffmpeg, "-f", "audiotoolbox", "-"];
	if (host.os === "win32")
		return ["powershell", "-NoProfile", "-NonInteractive", "-Command", mediaPlayerScript(path)];
	return undefined;
}

export interface PlayOptions extends OsOptions {
	signal?: AbortSignal;
	/** Download progress when ffmpeg is missing. */
	onStatus?: (s: ToolStatus) => void;
}

/** Play an audio file once. Resolves when playback ends. */
export async function playAudio(path: string, opts: PlayOptions = {}): Promise<void> {
	const host = opts.host ?? currentPlatform();
	const [name, ...args] = playCommand(path, host) ?? [];
	if (!name) throw new Error(`audio playback is not supported on ${host.os}`);
	const r = await runBinary(name, args, {
		env: opts.env,
		host,
		signal: opts.signal,
		onStatus: opts.onStatus,
	});
	if (r.code !== 0)
		throw new Error(r.stderr.trim() || `${name} exited with code ${r.code ?? "unknown"}`);
}
