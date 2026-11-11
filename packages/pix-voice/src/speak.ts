/** Text-to-speech tool. The provider comes from /pix → Voice; the result names the provider and model. */

import { basename, dirname, extname, join } from "node:path";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { formatToolStatus } from "@xynogen/pix-pretty/tool-status";
import { getErrorMessage, humanSize, renderCall } from "@xynogen/pix-pretty/utils";
import { playAudio } from "@xynogen/pix-runtime/audio";
import { randomUUID } from "@xynogen/pix-runtime/crypto";
import { mkdir, writeFile } from "@xynogen/pix-runtime/fs";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { validateOutputPath } from "@xynogen/pix-runtime/safe-path";
import { runToolExecution } from "@xynogen/pix-runtime/tool-execution";
import { Type } from "typebox";
import { voiceConfig, voiceModel } from "./config.ts";
import { resolveProvider } from "./providers.ts";
import { makeRenderResult } from "./render.ts";
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

export async function saveSpeech(
	outputFile: string,
	audio: Uint8Array,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const path = resolveOutputPath(outputFile);
	const validation = await validateOutputPath(path);
	if (!validation.ok) throw new Error(`output_file rejected: ${validation.reason}`);
	signal?.throwIfAborted();
	await mkdir(dirname(path), { recursive: true });
	signal?.throwIfAborted();
	await writeFile(path, audio);
	return path;
}

export default function registerSpeak(pi: ExtensionAPI): void {
	const renderResult = makeRenderResult<TtsDetails>({
		tool: "speak",
		target: (details) => basename(details.output_path),
		meta: (details) =>
			details.outcome === "cancelled"
				? "cancelled"
				: `${humanSize(details.bytes ?? 0)} · ${details.provider}/${details.model}`,
		status: (details) =>
			details.outcome === "error"
				? "error"
				: details.outcome === "cancelled"
					? "warning"
					: "success",
	});

	pi.registerTool({
		name: "speak",
		...({ exposure: "deferred" } as const),
		label: "Text to speech",
		renderShell: "self",
		description: "Text to speech: speak text aloud through the configured voice provider.",
		promptSnippet: "speak(input, output_file?)",
		renderCall: renderCall("speak", (args) => String(args.input ?? "").slice(0, 60)),
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
			return runToolExecution({
				signal,
				onUpdate,
				onError: (error, cancelled) => ({
					content: [
						{
							type: "text" as const,
							text: cancelled
								? "Speech generation cancelled."
								: `TTS failed (${details.provider}/${details.model}): ${getErrorMessage(error)}`,
						},
					],
					details: { ...details, outcome: cancelled ? ("cancelled" as const) : ("error" as const) },
					isError: !cancelled,
				}),
				execute: async ({ update }) => {
					const provider = resolveProvider("tts", voiceConfig.ttsProvider);
					details.provider = provider.id;
					details.model = voiceModel("tts", provider);
					update({
						content: [
							{ type: "text", text: `Generating speech with ${provider.id}/${details.model}...` },
						],
						details,
					});
					signal?.throwIfAborted();
					const speech = await provider.synthesize({
						input: params.input,
						model: details.model,
						format: FORMAT,
						signal,
					});
					signal?.throwIfAborted();
					details.format = speech.format;
					// A provider may return another format than requested. Name the file by the real one.
					const outputFile =
						params.output_file?.trim() ||
						join(tempDir(), `pix-tts-${randomUUID()}.${speech.format}`);
					details.output_path = resolveOutputPath(outputFile);
					const saved = await saveSpeech(outputFile, speech.audio, signal);
					signal?.throwIfAborted();
					const size = humanSize(speech.audio.byteLength);
					const mismatch =
						params.output_file && extname(saved).slice(1).toLowerCase() !== speech.format
							? ` · ${provider.id} returned ${speech.format}`
							: "";
					const play = voiceConfig.ttsPlay;
					if (play) {
						update({
							content: [
								{ type: "text", text: `${icon("audio.play")} ${basename(saved)} · ${size}` },
							],
							details,
						});
						signal?.throwIfAborted();
						// First run may download ffmpeg (~120 MB). Show it in the tool row.
						await player.play(saved, {
							signal,
							onStatus: (s) =>
								update({ content: [{ type: "text", text: formatToolStatus(s) }], details }),
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
				},
			});
		},
	});
}
