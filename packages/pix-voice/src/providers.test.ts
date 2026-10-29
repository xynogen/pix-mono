import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { registerBuiltinProviders } from "./builtin.ts";
import { splitModel } from "./http.ts";
import { listProviders, registerProvider, resolveProvider } from "./providers.ts";

const saved = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(() => {
	process.env = { ...saved };
	globalThis.fetch = originalFetch;
});

interface Captured {
	url: string;
	headers: Headers;
	body: unknown;
}

function captureFetch(reply: () => Response): Captured[] {
	const calls: Captured[] = [];
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body });
		return reply();
	}) as unknown as typeof fetch;
	return calls;
}

function audioFile(): string {
	const path = join(mkdtempSync(join(tempDir(), "pix-voice-audio-")), "clip.wav");
	writeFileSync(path, new Uint8Array([1, 2, 3, 4]));
	return path;
}

function provider<K extends "stt" | "tts">(kind: K, id: string) {
	registerBuiltinProviders();
	const found = listProviders(kind).find((item) => item.id === id);
	if (!found) throw new Error(`${kind} provider ${id} is not registered`);
	return found;
}

describe("provider registry", () => {
	test("registers every 9Router-backed provider family", () => {
		registerBuiltinProviders();
		const ids = (kind: "stt" | "tts") => new Set(listProviders(kind).map((item) => item.id));
		for (const id of [
			"9router",
			"openai",
			"groq",
			"deepgram",
			"assemblyai",
			"gemini",
			"huggingface",
			"nvidia",
			"selfhosted",
		])
			expect(ids("stt").has(id)).toBe(true);
		for (const id of [
			"9router",
			"openai",
			"elevenlabs",
			"gemini",
			"minimax",
			"minimax-cn",
			"fish-audio",
			"cartesia",
			"inworld",
			"nvidia",
			"openrouter",
			"xiaomi-mimo",
			"selfhosted",
		])
			expect(ids("tts").has(id)).toBe(true);
	});

	test("auto takes the first configured provider in registration order", () => {
		registerProvider("stt", {
			id: "test-off",
			defaultModel: "m",
			isConfigured: () => false,
			transcribe: async () => "",
		});
		for (const name of Object.keys(process.env))
			if (name.endsWith("_KEY")) delete process.env[name];
		process.env.GROQ_API_KEY = "groq-key";
		expect(resolveProvider("stt", "auto").id).toBe("groq");
	});

	test("an explicit provider without its key fails with the missing variable", () => {
		registerBuiltinProviders();
		delete process.env.DEEPGRAM_API_KEY;
		expect(() => resolveProvider("stt", "deepgram")).toThrow(/DEEPGRAM_API_KEY/);
	});

	test("splits model and voice at the last slash", () => {
		expect(splitModel("openai/gpt-4o-mini-tts/alloy", "x")).toEqual({
			model: "openai/gpt-4o-mini-tts",
			voice: "alloy",
		});
		expect(splitModel("sonic-2", "default")).toEqual({ model: "sonic-2", voice: "default" });
	});
});

describe("built-in STT providers", () => {
	test("OpenAI uses the current file model and plural language hints", async () => {
		process.env.OPENAI_API_KEY = "oa-key";
		const calls = captureFetch(() => Response.json({ text: "selamat pagi" }));
		const stt = provider("stt", "openai");
		const text = await stt.transcribe({
			file: audioFile(),
			model: stt.defaultModel,
			language: "id",
		});
		const form = calls[0]?.body as FormData;
		expect({
			text,
			url: calls[0]?.url,
			auth: calls[0]?.headers.get("authorization"),
			fields: [...form.keys()],
			model: form.get("model"),
			languages: form.getAll("languages[]"),
		}).toEqual({
			text: "selamat pagi",
			url: "https://api.openai.com/v1/audio/transcriptions",
			auth: "Bearer oa-key",
			fields: ["file", "model", "languages[]"],
			model: "gpt-transcribe",
			languages: ["id"],
		});
	});

	test("legacy multipart models retain singular language hints", async () => {
		process.env.GROQ_API_KEY = "groq-key";
		const calls = captureFetch(() => Response.json({ text: "hello" }));
		await provider("stt", "groq").transcribe({
			file: audioFile(),
			model: "whisper-large-v3-turbo",
			language: "en",
		});
		const form = calls[0]?.body as FormData;
		expect([...form.keys()]).toEqual(["file", "model", "language"]);
		expect(form.get("language")).toBe("en");
	});

	test("Gemini transcribes inline audio through Interactions and excludes input/thought steps", async () => {
		process.env.GEMINI_API_KEY = "g-key";
		const calls = captureFetch(() =>
			Response.json({
				steps: [
					{ type: "user_input", content: [{ type: "text", text: "prompt" }] },
					{ type: "thought", content: [{ type: "text", text: "private thought" }] },
					{
						type: "model_output",
						content: [
							{ type: "text", text: "hello" },
							{ type: "text", text: " world" },
						],
					},
				],
			}),
		);
		const stt = provider("stt", "gemini");
		expect(
			await stt.transcribe({ file: audioFile(), model: stt.defaultModel, language: "id" }),
		).toBe("hello world");
		expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
		expect(calls[0]?.headers.get("x-goog-api-key")).toBe("g-key");
		expect(JSON.parse(String(calls[0]?.body))).toEqual({
			model: "gemini-3.8-flash",
			input: [
				{
					type: "text",
					text: "Generate a transcript of the speech. Return only the transcribed text, no commentary. Language: id.",
				},
				{ type: "audio", mime_type: "audio/wav", data: "AQIDBA==" },
			],
		});
	});

	test("Gemini rejects missing output and empty transcripts", async () => {
		process.env.GEMINI_API_KEY = "g-key";
		const stt = provider("stt", "gemini");
		for (const reply of [
			{},
			{ steps: [] },
			{ steps: [{ type: "model_output", content: [{ type: "text", text: " " }] }] },
		]) {
			captureFetch(() => Response.json(reply));
			await expect(stt.transcribe({ file: audioFile(), model: stt.defaultModel })).rejects.toThrow(
				/Gemini returned no/,
			);
		}
	});

	test("9router posts multipart audio with the router key", async () => {
		process.env.NINEROUTER_URL = "https://router.test";
		process.env.NINEROUTER_KEY = "router-key";
		const calls = captureFetch(() => Response.json({ text: "hello" }));
		const text = await provider("stt", "9router").transcribe({
			file: audioFile(),
			model: "dg/nova-3",
		});
		expect({
			text,
			url: calls[0]?.url,
			auth: calls[0]?.headers.get("authorization"),
			model: (calls[0]?.body as FormData).get("model"),
		}).toEqual({
			text: "hello",
			url: "https://router.test/v1/audio/transcriptions",
			auth: "Bearer router-key",
			model: "dg/nova-3",
		});
	});

	test("deepgram sends raw audio with Token auth and reads the transcript", async () => {
		process.env.DEEPGRAM_API_KEY = "dg-key";
		const calls = captureFetch(() =>
			Response.json({ results: { channels: [{ alternatives: [{ transcript: "hi there" }] }] } }),
		);
		const text = await provider("stt", "deepgram").transcribe({
			file: audioFile(),
			model: "nova-3",
			language: "en",
		});
		const url = new URL(calls[0]?.url ?? "");
		expect({
			text,
			auth: calls[0]?.headers.get("authorization"),
			type: calls[0]?.headers.get("content-type"),
			model: url.searchParams.get("model"),
			language: url.searchParams.get("language"),
		}).toEqual({
			text: "hi there",
			auth: "Token dg-key",
			type: "audio/wav",
			model: "nova-3",
			language: "en",
		});
	});
});

describe("built-in TTS providers", () => {
	test("openai splits model/voice and returns the requested format", async () => {
		process.env.OPENAI_API_KEY = "oa-key";
		const calls = captureFetch(() => new Response(new Uint8Array([9, 9, 9])));
		const speech = await provider("tts", "openai").synthesize({
			input: "Hi",
			model: "gpt-4o-mini-tts/nova",
			format: "wav",
		});
		expect({
			bytes: [...speech.audio],
			format: speech.format,
			body: JSON.parse(String(calls[0]?.body)),
		}).toEqual({
			bytes: [9, 9, 9],
			format: "wav",
			body: { model: "gpt-4o-mini-tts", voice: "nova", input: "Hi", response_format: "wav" },
		});
	});

	test("Gemini returns Interactions WAV unchanged and sends verbatim input", async () => {
		process.env.GEMINI_API_KEY = "g-key";
		const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
		const calls = captureFetch(() =>
			Response.json({
				steps: [
					{
						type: "model_output",
						content: [
							{ type: "audio", mime_type: "audio/wav", data: Buffer.from(wav).toString("base64") },
						],
					},
				],
			}),
		);
		const tts = provider("tts", "gemini");
		const speech = await tts.synthesize({ input: "Hi", model: tts.defaultModel, format: "mp3" });
		expect({ format: speech.format, audio: [...speech.audio] }).toEqual({
			format: "wav",
			audio: [...wav],
		});
		expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
		expect(JSON.parse(String(calls[0]?.body))).toEqual({
			model: "gemini-3.8-flash-tts",
			input: [{ type: "user_input", content: [{ type: "text", text: "Hi" }] }],
			response_format: { type: "audio" },
			generation_config: { speech_config: [{ voice: "Kore" }] },
		});
	});

	test("Gemini rejects unexpected audio formats and missing audio", async () => {
		process.env.GEMINI_API_KEY = "g-key";
		for (const part of [
			{ type: "text", text: "no audio" },
			{ type: "audio", mime_type: "audio/l16", data: "AQI=" },
			{ type: "audio", mime_type: "audio/wav" },
		]) {
			captureFetch(() => Response.json({ steps: [{ type: "model_output", content: [part] }] }));
			const tts = provider("tts", "gemini");
			await expect(
				tts.synthesize({ input: "Hi", model: tts.defaultModel, format: "wav" }),
			).rejects.toThrow(/no (WAV )?audio/);
		}
	});

	test("Cartesia's current default always sends a voice and matching API version", async () => {
		process.env.CARTESIA_API_KEY = "c-key";
		const calls = captureFetch(() => new Response(new Uint8Array([1, 2])));
		const tts = provider("tts", "cartesia");
		for (const model of [tts.defaultModel, "sonic-3.6", "sonic-3.6/custom-voice"]) {
			const speech = await tts.synthesize({ input: "Hi", model, format: "mp3" });
			expect({ audio: [...speech.audio], format: speech.format }).toEqual({
				audio: [1, 2],
				format: "mp3",
			});
		}
		for (const [i, call] of calls.entries()) {
			expect(call.url).toBe("https://api.cartesia.ai/tts/bytes");
			expect(call.headers.get("Cartesia-Version")).toBe("2026-08-14");
			expect(call.headers.get("X-API-Key")).toBe("c-key");
			expect(JSON.parse(String(call.body))).toEqual({
				model_id: "sonic-3.6",
				transcript: "Hi",
				voice: i === 2 ? "custom-voice" : "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
				output_format: { container: "mp3", bit_rate: 128000, sample_rate: 44100 },
			});
		}
	});

	test("Inworld's current flash model preserves explicit voice selection", async () => {
		process.env.INWORLD_API_KEY = "iw-key";
		const calls = captureFetch(() => Response.json({ audioContent: "AQI=" }));
		const tts = provider("tts", "inworld");
		for (const model of [
			tts.defaultModel,
			"inworld-tts-2-flash",
			"inworld-tts-2-flash/custom-voice",
		]) {
			expect(await tts.synthesize({ input: "Hi", model, format: "mp3" })).toEqual({
				audio: new Uint8Array([1, 2]),
				format: "mp3",
			});
		}
		for (const [i, call] of calls.entries()) {
			expect(call.url).toBe("https://api.inworld.ai/tts/v1/voice");
			expect(call.headers.get("authorization")).toBe("Basic iw-key");
			expect(JSON.parse(String(call.body))).toEqual({
				modelId: "inworld-tts-2-flash",
				voiceId: i === 2 ? "custom-voice" : "Ashley",
				text: "Hi",
				audioConfig: { audioEncoding: "MP3" },
			});
		}
	});

	test("OpenRouter uses a listed chat-audio model and assembles SSE audio", async () => {
		process.env.OPENROUTER_API_KEY = "or-key";
		const calls = captureFetch(
			() =>
				new Response(
					[
						": keep-alive",
						'data: {"choices":[{"delta":{"audio":{"data":"AQ"}}}]}',
						'data: {"choices":[{"delta":{"audio":{"data":"IDBA=="}}}]}',
						"data: [DONE]",
					].join("\n"),
				),
		);
		const tts = provider("tts", "openrouter");
		expect(
			await tts.synthesize({ input: "Read this aloud", model: tts.defaultModel, format: "wav" }),
		).toEqual({ audio: new Uint8Array([1, 2, 3, 4]), format: "wav" });
		expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer or-key");
		expect(JSON.parse(String(calls[0]?.body))).toEqual({
			model: "openai/gpt-audio",
			modalities: ["text", "audio"],
			audio: { voice: "alloy", format: "wav" },
			stream: true,
			messages: [{ role: "user", content: "Read this aloud" }],
		});
	});

	test("minimax decodes hex audio and surfaces a status error", async () => {
		process.env.MINIMAX_API_KEY = "mm-key";
		captureFetch(() => Response.json({ base_resp: { status_code: 0 }, data: { audio: "0aff" } }));
		const ok = await provider("tts", "minimax").synthesize({
			input: "Hi",
			model: "speech-2.8-hd/Narrator",
			format: "mp3",
		});
		expect([...ok.audio]).toEqual([10, 255]);

		captureFetch(() =>
			Response.json({ base_resp: { status_code: 1004, status_msg: "invalid api key" } }),
		);
		await expect(
			provider("tts", "minimax").synthesize({ input: "Hi", model: "speech-2.8-hd", format: "mp3" }),
		).rejects.toThrow("invalid api key");
	});
});
