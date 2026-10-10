/**
 * Built-in STT and TTS providers. The set follows the direct adapters in
 * 9Router (open-sse/handlers/sttCore.js and ttsProviders/). Registration order
 * is the "auto" order: 9Router first, then keyed cloud APIs, then self-hosted.
 *
 * ponytail: skipped 9Router adapters that scrape a web page (edge-tts,
 * google-tts), need AWS SigV4 (aws-polly), or target one desktop OS
 * (local-device). 9Router still reaches them as `9router` models.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
	bearer,
	bytes,
	env,
	fromBase64,
	json,
	mimeType,
	parseTranscriptionResponse,
	pcmToWav,
	request,
	routerBaseUrl,
	routerKey,
	splitModel,
} from "./http.ts";
import {
	registerProvider,
	type SpeechRequest,
	type SttProvider,
	type TranscribeRequest,
	type TtsProvider,
} from "./providers.ts";

const has =
	(...names: string[]) =>
	() =>
		names.every((name) => Boolean(process.env[name]));

async function audioBlob(file: string, signal?: AbortSignal): Promise<Blob> {
	return new Blob([await readFile(file, { signal })], { type: mimeType(file) });
}

/** OpenAI-compatible multipart `/audio/transcriptions`. */
async function openaiTranscribe(url: string, key: string, req: TranscribeRequest): Promise<string> {
	const form = new FormData();
	form.append("file", await audioBlob(req.file, req.signal), basename(req.file));
	form.append("model", req.model);
	if (req.language) form.append("language", req.language);
	const response = await request(url, {
		method: "POST",
		headers: bearer(key),
		body: form,
		signal: req.signal,
	});
	return parseTranscriptionResponse(await response.text());
}

/** OpenAI-compatible JSON `/audio/speech`, with the model given as "model/voice". */
async function openaiSpeech(url: string, key: string, req: SpeechRequest, defaultVoice: string) {
	const { model, voice } = splitModel(req.model, defaultVoice);
	const response = await request(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...bearer(key) },
		body: JSON.stringify({ model, voice, input: req.input, response_format: req.format }),
		signal: req.signal,
	});
	return { audio: await bytes(response), format: req.format };
}

/** Strip a pasted endpoint or `/v1` suffix so a base URL works either way. */
function baseOf(url: string, suffix: string): string {
	return url
		.replace(/\/+$/, "")
		.replace(new RegExp(`${suffix}$`), "")
		.replace(/\/v1$/, "");
}

// ── Speech to text ──────────────────────────────────────────────────────────

const stt: SttProvider[] = [
	{
		id: "9router",
		defaultModel: "dg/nova-3",
		env: ["NINEROUTER_URL", "NINEROUTER_KEY"],
		isConfigured: () => Boolean(routerKey()),
		transcribe: (req) =>
			openaiTranscribe(`${routerBaseUrl()}/audio/transcriptions`, routerKey(), req),
	},
	{
		id: "openai",
		defaultModel: "gpt-4o-mini-transcribe",
		env: ["OPENAI_API_KEY"],
		isConfigured: has("OPENAI_API_KEY"),
		transcribe: (req) =>
			openaiTranscribe(
				"https://api.openai.com/v1/audio/transcriptions",
				env("OPENAI_API_KEY"),
				req,
			),
	},
	{
		id: "groq",
		defaultModel: "whisper-large-v3-turbo",
		env: ["GROQ_API_KEY"],
		isConfigured: has("GROQ_API_KEY"),
		transcribe: (req) =>
			openaiTranscribe(
				"https://api.groq.com/openai/v1/audio/transcriptions",
				env("GROQ_API_KEY"),
				req,
			),
	},
	{
		id: "deepgram",
		defaultModel: "nova-3",
		env: ["DEEPGRAM_API_KEY"],
		isConfigured: has("DEEPGRAM_API_KEY"),
		async transcribe(req) {
			const url = new URL("https://api.deepgram.com/v1/listen");
			url.searchParams.set("model", req.model);
			url.searchParams.set("smart_format", "true");
			url.searchParams.set("punctuate", "true");
			if (req.language) url.searchParams.set("language", req.language);
			else url.searchParams.set("detect_language", "true");
			const data = await json(url.toString(), {
				method: "POST",
				headers: {
					Authorization: `Token ${env("DEEPGRAM_API_KEY")}`,
					"Content-Type": mimeType(req.file),
				},
				body: await readFile(req.file, { signal: req.signal }),
				signal: req.signal,
			});
			const results = data.results as
				| { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }
				| undefined;
			return results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
		},
	},
	{
		id: "assemblyai",
		defaultModel: "universal-2",
		env: ["ASSEMBLYAI_API_KEY"],
		isConfigured: has("ASSEMBLYAI_API_KEY"),
		async transcribe(req) {
			const auth = { Authorization: env("ASSEMBLYAI_API_KEY") };
			const upload = await json("https://api.assemblyai.com/v2/upload", {
				method: "POST",
				headers: { ...auth, "Content-Type": "application/octet-stream" },
				body: await readFile(req.file, { signal: req.signal }),
				signal: req.signal,
			});
			const job = await json("https://api.assemblyai.com/v2/transcript", {
				method: "POST",
				headers: { ...auth, "Content-Type": "application/json" },
				body: JSON.stringify({
					audio_url: upload.upload_url,
					speech_models: [req.model],
					...(req.language ? { language_code: req.language } : { language_detection: true }),
				}),
				signal: req.signal,
			});
			// ponytail: fixed 2 s poll with a 10 min ceiling. Raise the ceiling for very long audio.
			const deadline = Date.now() + 10 * 60_000;
			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 2000));
				req.signal?.throwIfAborted();
				const poll = await json(`https://api.assemblyai.com/v2/transcript/${job.id}`, {
					headers: auth,
					signal: req.signal,
				});
				if (poll.status === "completed") return String(poll.text ?? "");
				if (poll.status === "error") throw new Error(String(poll.error ?? "AssemblyAI failed"));
			}
			throw new Error("AssemblyAI did not finish in 10 minutes");
		},
	},
	{
		id: "gemini",
		defaultModel: "gemini-2.5-flash",
		env: ["GEMINI_API_KEY"],
		isConfigured: has("GEMINI_API_KEY"),
		async transcribe(req) {
			const audio = await readFile(req.file, { signal: req.signal });
			const prompt = `Generate a transcript of the speech. Return only the transcribed text, no commentary.${req.language ? ` Language: ${req.language}.` : ""}`;
			const data = await json(
				`https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", "x-goog-api-key": env("GEMINI_API_KEY") },
					body: JSON.stringify({
						contents: [
							{
								parts: [
									{ text: prompt },
									{
										inline_data: {
											mime_type: mimeType(req.file),
											data: audio.toString("base64"),
										},
									},
								],
							},
						],
					}),
					signal: req.signal,
				},
			);
			const candidates = data.candidates as
				| Array<{ content?: { parts?: Array<{ text?: string }> } }>
				| undefined;
			return (candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
		},
	},
	{
		id: "huggingface",
		defaultModel: "openai/whisper-large-v3-turbo",
		env: ["HF_TOKEN"],
		isConfigured: has("HF_TOKEN"),
		async transcribe(req) {
			if (req.model.includes("..")) throw new Error("invalid Hugging Face model id");
			const data = await json(`https://router.huggingface.co/hf-inference/models/${req.model}`, {
				method: "POST",
				headers: { ...bearer(env("HF_TOKEN")), "Content-Type": mimeType(req.file) },
				body: await readFile(req.file, { signal: req.signal }),
				signal: req.signal,
			});
			return String(data.text ?? "");
		},
	},
	{
		id: "nvidia",
		defaultModel: "nvidia/parakeet-ctc-1.1b-asr",
		env: ["NVIDIA_API_KEY"],
		isConfigured: has("NVIDIA_API_KEY"),
		transcribe: (req) =>
			openaiTranscribe(
				"https://integrate.api.nvidia.com/v1/audio/transcriptions",
				env("NVIDIA_API_KEY"),
				req,
			),
	},
	{
		id: "selfhosted",
		defaultModel: "whisper-1",
		env: ["SELFHOSTED_STT_URL", "SELFHOSTED_API_KEY"],
		isConfigured: has("SELFHOSTED_STT_URL"),
		transcribe: (req) =>
			openaiTranscribe(
				`${baseOf(env("SELFHOSTED_STT_URL"), "/v1/audio/transcriptions")}/v1/audio/transcriptions`,
				env("SELFHOSTED_API_KEY"),
				req,
			),
	},
];

// ── Text to speech ──────────────────────────────────────────────────────────

/** Chat-completions audio reply (Xiaomi MiMo): base64 in choices[0].message.audio. */
async function chatAudio(url: string, key: string, body: unknown, signal?: AbortSignal) {
	const data = await json(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...bearer(key) },
		body: JSON.stringify(body),
		signal,
	});
	const choices = data.choices as
		| Array<{ message?: { audio?: { data?: string; format?: string } } }>
		| undefined;
	const audio = choices?.[0]?.message?.audio;
	return { audio: fromBase64(audio?.data), format: audio?.format || "wav" };
}

function minimax(id: string, host: string, envName: string): TtsProvider {
	return {
		id,
		defaultModel: "speech-2.8-hd/English_expressive_narrator",
		env: [envName],
		isConfigured: has(envName),
		async synthesize(req) {
			const { model, voice } = splitModel(req.model, "English_expressive_narrator");
			const data = await json(`https://${host}/v1/t2a_v2`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...bearer(env(envName)) },
				body: JSON.stringify({
					model,
					text: req.input,
					stream: false,
					language_boost: "auto",
					output_format: "hex",
					voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
					audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
				}),
				signal: req.signal,
			});
			const status = (data.base_resp ?? {}) as { status_code?: number; status_msg?: string };
			if (status.status_code) throw new Error(status.status_msg || "MiniMax TTS upstream error");
			const hex = (data.data as { audio?: string } | undefined)?.audio ?? "";
			if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error("MiniMax TTS returned no audio");
			return { audio: new Uint8Array(Buffer.from(hex, "hex")), format: "mp3" };
		},
	};
}

const tts: TtsProvider[] = [
	{
		id: "9router",
		defaultModel: "edge-tts/en-US-AriaNeural",
		env: ["NINEROUTER_URL", "NINEROUTER_KEY"],
		isConfigured: () => Boolean(routerKey()),
		async synthesize(req) {
			const response = await request(
				`${routerBaseUrl()}/audio/speech?response_format=${req.format}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", ...bearer(routerKey()) },
					body: JSON.stringify({ model: req.model, input: req.input }),
					signal: req.signal,
				},
			);
			return { audio: await bytes(response), format: req.format };
		},
	},
	{
		id: "openai",
		defaultModel: "gpt-4o-mini-tts/alloy",
		env: ["OPENAI_API_KEY"],
		isConfigured: has("OPENAI_API_KEY"),
		synthesize: (req) =>
			openaiSpeech("https://api.openai.com/v1/audio/speech", env("OPENAI_API_KEY"), req, "alloy"),
	},
	{
		id: "elevenlabs",
		defaultModel: "eleven_flash_v2_5/21m00Tcm4TlvDq8ikWAM",
		env: ["ELEVENLABS_API_KEY"],
		isConfigured: has("ELEVENLABS_API_KEY"),
		async synthesize(req) {
			const { model, voice } = splitModel(req.model, "21m00Tcm4TlvDq8ikWAM");
			const response = await request(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "xi-api-key": env("ELEVENLABS_API_KEY") },
				body: JSON.stringify({
					text: req.input,
					model_id: model,
					voice_settings: { stability: 0.5, similarity_boost: 0.75 },
				}),
				signal: req.signal,
			});
			return { audio: await bytes(response), format: "mp3" };
		},
	},
	{
		id: "gemini",
		defaultModel: "gemini-2.5-flash-preview-tts/Kore",
		env: ["GEMINI_API_KEY"],
		isConfigured: has("GEMINI_API_KEY"),
		async synthesize(req) {
			const { model, voice } = splitModel(req.model, "Kore");
			const data = await json(
				`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", "x-goog-api-key": env("GEMINI_API_KEY") },
					body: JSON.stringify({
						contents: [
							{ parts: [{ text: /:\s/.test(req.input) ? req.input : `Say: ${req.input}` }] },
						],
						generationConfig: {
							responseModalities: ["AUDIO"],
							speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
						},
					}),
					signal: req.signal,
				},
			);
			const candidates = data.candidates as
				| Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>
				| undefined;
			const pcm = candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data);
			// Gemini returns 16-bit mono PCM at 24 kHz.
			return { audio: pcmToWav(fromBase64(pcm?.inlineData?.data)), format: "wav" };
		},
	},
	minimax("minimax", "api.minimax.io", "MINIMAX_API_KEY"),
	minimax("minimax-cn", "api.minimaxi.com", "MINIMAX_CN_API_KEY"),
	{
		id: "fish-audio",
		defaultModel: "s2.1-pro-free",
		env: ["FISH_AUDIO_API_KEY"],
		isConfigured: has("FISH_AUDIO_API_KEY"),
		async synthesize(req) {
			const { model, voice } = splitModel(req.model, "");
			const response = await request("https://api.fish.audio/v1/tts", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...bearer(env("FISH_AUDIO_API_KEY")),
					model,
				},
				body: JSON.stringify({
					text: req.input,
					format: "mp3",
					...(voice ? { reference_id: voice } : {}),
				}),
				signal: req.signal,
			});
			return { audio: await bytes(response), format: "mp3" };
		},
	},
	{
		id: "cartesia",
		defaultModel: "sonic-3.6",
		env: ["CARTESIA_API_KEY"],
		isConfigured: has("CARTESIA_API_KEY"),
		async synthesize(req) {
			const { model, voice } = splitModel(req.model, "");
			const response = await request("https://api.cartesia.ai/tts/bytes", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-API-Key": env("CARTESIA_API_KEY"),
					"Cartesia-Version": "2024-06-10",
				},
				body: JSON.stringify({
					model_id: model,
					transcript: req.input,
					...(voice ? { voice: { mode: "id", id: voice } } : {}),
					output_format: { container: "mp3", bit_rate: 128000, sample_rate: 44100 },
				}),
				signal: req.signal,
			});
			return { audio: await bytes(response), format: "mp3" };
		},
	},
	{
		id: "inworld",
		defaultModel: "inworld-tts-1.5-mini/Alex",
		env: ["INWORLD_API_KEY"],
		isConfigured: has("INWORLD_API_KEY"),
		async synthesize(req) {
			const { model, voice } = splitModel(req.model, "Alex");
			const data = await json("https://api.inworld.ai/tts/v1/voice", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Basic ${env("INWORLD_API_KEY")}`,
				},
				body: JSON.stringify({
					text: req.input,
					voiceId: voice,
					modelId: model,
					audioConfig: { audioEncoding: "MP3" },
				}),
				signal: req.signal,
			});
			return { audio: fromBase64(data.audioContent), format: "mp3" };
		},
	},
	{
		id: "nvidia",
		defaultModel: "fastpitch/default",
		env: ["NVIDIA_API_KEY"],
		isConfigured: has("NVIDIA_API_KEY"),
		async synthesize(req) {
			const { model, voice } = splitModel(req.model, "default");
			const response = await request("https://integrate.api.nvidia.com/v1/audio/speech", {
				method: "POST",
				headers: { "Content-Type": "application/json", ...bearer(env("NVIDIA_API_KEY")) },
				body: JSON.stringify({ input: { text: req.input }, voice, model }),
				signal: req.signal,
			});
			return { audio: await bytes(response), format: "wav" };
		},
	},
	{
		id: "openrouter",
		defaultModel: "openai/gpt-4o-mini-tts/alloy",
		env: ["OPENROUTER_API_KEY"],
		isConfigured: has("OPENROUTER_API_KEY"),
		async synthesize(req) {
			const { model, voice } = splitModel(req.model, "alloy");
			const response = await request("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json", ...bearer(env("OPENROUTER_API_KEY")) },
				body: JSON.stringify({
					model,
					modalities: ["text", "audio"],
					audio: { voice, format: "wav" },
					stream: true,
					messages: [{ role: "user", content: req.input }],
				}),
				signal: req.signal,
			});
			// The audio arrives as base64 chunks in SSE deltas.
			const chunks: string[] = [];
			for (const line of (await response.text()).split("\n")) {
				if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
				try {
					const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
					if (delta?.audio?.data) chunks.push(delta.audio.data);
				} catch {
					// A keep-alive or partial line carries no audio.
				}
			}
			return { audio: fromBase64(chunks.join("")), format: "wav" };
		},
	},
	{
		id: "xiaomi-mimo",
		defaultModel: "mimo-v2.5-tts/mimo_default",
		env: ["XIAOMI_API_KEY"],
		isConfigured: has("XIAOMI_API_KEY"),
		synthesize(req) {
			const { model, voice } = splitModel(req.model, "mimo_default");
			return chatAudio(
				"https://api.xiaomimimo.com/v1/chat/completions",
				env("XIAOMI_API_KEY"),
				{
					model,
					stream: false,
					messages: [{ role: "assistant", content: req.input }],
					audio: { format: "wav", voice },
				},
				req.signal,
			);
		},
	},
	{
		id: "selfhosted",
		defaultModel: "kokoro/af_heart",
		env: ["SELFHOSTED_TTS_URL", "SELFHOSTED_API_KEY"],
		isConfigured: has("SELFHOSTED_TTS_URL"),
		synthesize: (req) =>
			openaiSpeech(
				`${baseOf(env("SELFHOSTED_TTS_URL"), "/v1/audio/speech")}/v1/audio/speech`,
				env("SELFHOSTED_API_KEY"),
				req,
				"af_heart",
			),
	},
];

export function registerBuiltinProviders(): void {
	for (const provider of stt) registerProvider("stt", provider);
	for (const provider of tts) registerProvider("tts", provider);
}
