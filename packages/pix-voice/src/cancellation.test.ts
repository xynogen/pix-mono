import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { voiceConfig } from "./config.ts";
import { registerProvider } from "./providers.ts";
import registerSpeak, { player, saveSpeech } from "./speak.ts";
import registerTranscribe, { transcribeAudioFile, writeTranscriptionFile } from "./transcribe.ts";

const original = { ...voiceConfig };
const originalPlay = player.play;
afterEach(() => {
	Object.assign(voiceConfig, original);
	player.play = originalPlay;
});

for (const name of ["speak", "transcribe"] as const) {
	for (const when of ["before start", "during progress", "during provider"] as const) {
		test(`${name}: cancel ${when} preserves the existing file and skips playback`, async () => {
			const dir = await mkdtemp(join(tempDir(), "pix-voice-cancel-"));
			try {
				const path = join(dir, "existing.txt");
				await writeFile(path, "keep me");
				const controller = new AbortController();
				let calls = 0;
				let updates = 0;
				let played = 0;
				let complete!: () => void;
				const provider = async (signal?: AbortSignal) => {
					calls++;
					expect(signal).toBe(controller.signal);
					await new Promise<void>((resolve) => {
						complete = resolve;
					});
				};
				const id = `cancel-${name}-${when}`;
				if (name === "speak") {
					registerProvider("tts", {
						id,
						defaultModel: "test",
						synthesize: async ({ signal }) => {
							await provider(signal);
							return { audio: new Uint8Array([1, 2]), format: "mp3" };
						},
					});
					voiceConfig.ttsProvider = id;
				} else {
					registerProvider("stt", {
						id,
						defaultModel: "test",
						transcribe: async ({ signal }) => {
							await provider(signal);
							return "late transcript";
						},
					});
					voiceConfig.sttProvider = id;
				}
				voiceConfig.ttsPlay = true;
				player.play = async () => {
					played++;
				};
				let tool!: ToolDefinition;
				const pi = {
					registerTool: (value: ToolDefinition) => {
						tool = value;
					},
				};
				if (name === "speak") registerSpeak(pi as never);
				else registerTranscribe(pi as never);
				if (when === "before start") controller.abort();
				const pending = tool.execute(
					"cancel",
					{ input: "hi", file: "audio.wav", output_file: path },
					controller.signal,
					() => {
						updates++;
						if (when === "during progress") controller.abort();
					},
					{} as never,
				);
				if (when === "during provider") {
					expect(calls).toBe(1);
					controller.abort(new Error("stop"));
					complete();
				}
				const result = await pending;
				expect(result).toMatchObject({
					content: [
						{
							type: "text",
							text: name === "speak" ? "Speech generation cancelled." : "Transcription cancelled.",
						},
					],
					details: { outcome: "cancelled", provider: id },
					isError: false,
				});
				expect({ calls, updates, played }).toEqual({
					calls: when === "during provider" ? 1 : 0,
					updates: when === "before start" ? 0 : 1,
					played: 0,
				});
				expect(await readFile(path, "utf8")).toBe("keep me");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});
	}
}

test("cancelled file helpers leave existing content unchanged", async () => {
	const dir = await mkdtemp(join(tempDir(), "pix-voice-write-cancel-"));
	try {
		const path = join(dir, "existing.txt");
		await writeFile(path, "keep me");
		const signal = AbortSignal.abort(new Error("cancelled"));
		await expect(saveSpeech(path, new Uint8Array([1]), signal)).rejects.toThrow("cancelled");
		await expect(writeTranscriptionFile(path, "replace", signal)).rejects.toThrow("cancelled");
		expect(await readFile(path, "utf8")).toBe("keep me");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("dictation rejects late provider success after cancellation", async () => {
	const controller = new AbortController();
	registerProvider("stt", {
		id: "cancel-dictation",
		defaultModel: "test",
		transcribe: async () => {
			controller.abort(new Error("stop dictation"));
			return "late";
		},
	});
	voiceConfig.sttProvider = "cancel-dictation";
	await expect(transcribeAudioFile("audio.wav", controller.signal)).rejects.toThrow(
		"stop dictation",
	);
});

test("speak suppresses late playback progress and normalizes playback cancellation", async () => {
	const dir = await mkdtemp(join(tempDir(), "pix-voice-play-cancel-"));
	try {
		registerProvider("tts", {
			id: "cancel-playback",
			defaultModel: "test",
			synthesize: async () => ({ audio: new Uint8Array([1]), format: "mp3" }),
		});
		voiceConfig.ttsProvider = "cancel-playback";
		voiceConfig.ttsPlay = true;
		const controller = new AbortController();
		let lateUpdate!: () => void;
		let updates = 0;
		player.play = async (_file, options) => {
			lateUpdate = () =>
				options?.onStatus?.({ kind: "failed", name: "ffmpeg", error: "late", hint: "test" });
			controller.abort();
			lateUpdate();
		};
		let tool!: ToolDefinition;
		registerSpeak({
			registerTool: (value: ToolDefinition) => {
				tool = value;
			},
		} as never);
		const result = await tool.execute(
			"play",
			{ input: "hi", output_file: join(dir, "audio.mp3") },
			controller.signal,
			() => {
				updates++;
			},
			{} as never,
		);
		expect(result).toMatchObject({ details: { outcome: "cancelled" }, isError: false });
		expect(updates).toBe(2);
		lateUpdate();
		expect(updates).toBe(2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
