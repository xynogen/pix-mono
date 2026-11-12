import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setIconMode } from "@xynogen/pix-pretty/icon-catalog";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { voiceConfig } from "../src/config.ts";
import { registerProvider, type SpeechRequest } from "../src/providers.ts";
import registerSpeak, { player, saveSpeech } from "../src/speak.ts";

const oldProvider = voiceConfig.ttsProvider;
const oldPlay = voiceConfig.ttsPlay;
const oldPlayer = player.play;

afterEach(() => {
	voiceConfig.ttsProvider = oldProvider;
	voiceConfig.ttsPlay = oldPlay;
	player.play = oldPlayer;
	setIconMode("nerd");
});

type Execute = (
	id: string,
	params: {
		input: string;
		output_file: string;
	},
	signal: AbortSignal | undefined,
	onUpdate: ((update: { content: Array<{ type: string; text: string }> }) => void) | undefined,
) => Promise<{
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}>;

function captureExecute(): Execute {
	let execute: Execute | undefined;
	registerSpeak({
		registerTool(tool: { execute: Execute }) {
			execute = tool.execute;
		},
	} as never);
	if (!execute) throw new Error("speak tool was not registered");
	return execute;
}

/** Register a fake provider that returns `size` bytes in `format`. */
function fakeProvider(id: string, format: string, size = 21_168) {
	const calls: SpeechRequest[] = [];
	registerProvider("tts", {
		id,
		defaultModel: "fake-model/fake-voice",
		synthesize: async (request) => {
			calls.push(request);
			return { audio: new Uint8Array(size), format };
		},
	});
	voiceConfig.ttsProvider = id;
	return calls;
}

describe("speak tool", () => {
	test("saves audio bytes without text conversion", async () => {
		const dir = mkdtempSync(join(tempDir(), "pix-tts-"));
		const path = join(dir, "speech.mp3");
		await saveSpeech(path, new Uint8Array([0, 255, 17, 128]));
		expect([...new Uint8Array(await readFile(path))]).toEqual([0, 255, 17, 128]);
		await rm(dir, { recursive: true, force: true });
	});

	test("uses the provider default model and plays the result", async () => {
		const calls = fakeProvider("test-tts-play", "mp3");
		const dir = mkdtempSync(join(tempDir(), "pix-tts-result-"));
		const path = join(dir, "speech.mp3");
		// Playback is a pix-runtime job. Record the call instead of playing audio.
		const played: string[] = [];
		player.play = async (file) => {
			played.push(file);
		};
		voiceConfig.ttsPlay = true;
		setIconMode("unicode");
		const updates: string[] = [];
		try {
			const result = await captureExecute()(
				"test",
				{ input: "Hello", output_file: path },
				undefined,
				(update) => updates.push(update.content[0]?.text ?? ""),
			);
			expect(calls[0]).toMatchObject({ model: "fake-model/fake-voice", format: "mp3" });
			expect(updates).toEqual([
				"Generating speech with test-tts-play/fake-model/fake-voice...",
				"\u25B6\uFE0E speech.mp3 · 20.7 KiB",
			]);
			expect(result.content[0]?.text).toBe("\u25A0\uFE0E speech.mp3 · 20.7 KiB");
			expect(result.details).toMatchObject({ provider: "test-tts-play", outcome: "success" });
			expect(played).toEqual([path]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("names the file by the real format and reports a format mismatch", async () => {
		fakeProvider("test-tts-wav", "wav");
		const dir = mkdtempSync(join(tempDir(), "pix-tts-saved-"));
		const path = join(dir, "speech.mp3");
		voiceConfig.ttsPlay = false;
		setIconMode("unicode");
		try {
			const result = await captureExecute()(
				"test",
				{ input: "Hello", output_file: path },
				undefined,
				undefined,
			);
			expect(result.content[0]?.text).toBe(
				`\u266B\uFE0E ${path} · 20.7 KiB · test-tts-wav returned wav`,
			);
			expect(result.details).toMatchObject({ format: "wav", model: "fake-model/fake-voice" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("returns a structured error that names the provider", async () => {
		registerProvider("tts", {
			id: "test-tts-fail",
			defaultModel: "x",
			synthesize: async () => {
				throw new Error("401: bad key");
			},
		});
		voiceConfig.ttsProvider = "test-tts-fail";
		const result = await captureExecute()(
			"test",
			{ input: "Hello", output_file: join(tempDir(), "unused.mp3") },
			undefined,
			undefined,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe("TTS failed (test-tts-fail/x): 401: bad key");
		expect(result.details).toMatchObject({ outcome: "error", provider: "test-tts-fail" });
	});
});
