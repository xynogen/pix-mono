/** Text-to-speech tool. The provider comes from /pix → Voice; the result names the provider and model. */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { formatToolStatus } from "@xynogen/pix-pretty/tool-status";
import { getErrorMessage, humanSize } from "@xynogen/pix-pretty/utils";
import { playAudio } from "@xynogen/pix-runtime/audio";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { validateOutputPath } from "@xynogen/pix-runtime/safe-path";
import { Type } from "typebox";
import { voiceConfig, voiceModel } from "./config.ts";
import { resolveProvider } from "./providers.ts";
import { makeRenderCall, makeRenderResult } from "./render.ts";
import { resolveOutputPath } from "./transcribe.ts";

// ponytail: mp3 plays everywhere. Add a /pix → Voice format setting if a provider needs another.
const FORMAT = "mp3";

interface TtsDetails {
	_type: "ttsResult";
	outcome: "running" | "success" | "cancelled" | "error";
	provider: string;
	model: string;
	format: string;
	output_path: string;
	bytes?: number;
}

/** Test seam for playback. */
export const player = { play: playAudio };

export async function saveSpeech(outputFile: string, audio: Uint8Array): Promise<string> {
	const path = resolveOutputPath(outputFile);
	const validation = await validateOutputPath(path);
	if (!validation.ok) throw new Error(`output_file rejected: ${validation.reason}`);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, audio);
	return path;
}

export default function registerSpeak(pi: ExtensionAPI): void {
	const renderResult = makeRenderResult<TtsDetails>({
		tool: "speak",
		target: (details) => basename(details.output_path),
		meta: (details) => `${humanSize(details.bytes ?? 0)} · ${details.provider}/${details.model}`,
		status: (details) => (details.outcome === "error" ? "error" : "success"),
	});

	pi.registerTool({
		name: "speak",
		...({ exposure: "deferred" } as const),
		label: "Text to speech",
		renderShell: "self",
		description: "Text to speech: speak text aloud through the configured voice provider.",
		promptSnippet: "speak(input, output_file?)",
		renderCall: makeRenderCall("speak", (args) => String(args.input ?? "").slice(0, 60)),
		renderResult,
		parameters: Type.Object({
			input: Type.String({ description: "Text to speak" }),
			output_file: Type.Optional(
				Type.String({ description: "Save the audio here (default: temp file)" }),
			),
		}),

		async execute(_id, params, signal, onUpdate) {
			const details: TtsDetails = {
				_type: "ttsResult",
				outcome: "running",
				provider: voiceConfig.ttsProvider,
				model: "",
				format: FORMAT,
				output_path: "",
			};
			try {
				const provider = resolveProvider("tts", voiceConfig.ttsProvider);
				details.provider = provider.id;
				details.model = voiceModel("tts", provider);
				onUpdate?.({
					content: [
						{ type: "text", text: `Generating speech with ${provider.id}/${details.model}...` },
					],
					details,
				});
				const speech = await provider.synthesize({
					input: params.input,
					model: details.model,
					format: FORMAT,
					signal,
				});
				details.format = speech.format;
				// A provider may return another format than requested. Name the file by the real one.
				const outputFile =
					params.output_file?.trim() || join(tempDir(), `pix-tts-${randomUUID()}.${speech.format}`);
				details.output_path = resolveOutputPath(outputFile);
				const saved = await saveSpeech(outputFile, speech.audio);
				const size = humanSize(speech.audio.byteLength);
				const mismatch =
					params.output_file && extname(saved).slice(1).toLowerCase() !== speech.format
						? ` · ${provider.id} returned ${speech.format}`
						: "";
				const play = voiceConfig.ttsPlay;
				if (play) {
					onUpdate?.({
						content: [{ type: "text", text: `${icon("audio.play")} ${basename(saved)} · ${size}` }],
						details,
					});
					// First run may download ffmpeg (~120 MB). Show it in the tool row.
					await player.play(saved, {
						signal,
						onStatus: (s) =>
							onUpdate?.({ content: [{ type: "text", text: formatToolStatus(s) }], details }),
					});
				}
				return {
					content: [
						{
							type: "text",
							text: play
								? `${icon("audio.stop")} ${basename(saved)} · ${size}${mismatch}`
								: `${icon("audio.file")} ${saved} · ${size}${mismatch}`,
						},
					],
					details: {
						...details,
						outcome: "success" as const,
						output_path: saved,
						bytes: speech.audio.byteLength,
					},
				};
			} catch (error) {
				const message = getErrorMessage(error);
				return {
					content: [
						{ type: "text", text: `TTS failed (${details.provider}/${details.model}): ${message}` },
					],
					details: {
						...details,
						outcome: signal?.aborted ? ("cancelled" as const) : ("error" as const),
					},
					isError: true,
				};
			}
		},
	});
}
