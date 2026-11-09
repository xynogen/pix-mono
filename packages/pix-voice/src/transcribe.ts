/**
 * transcribe.ts — speech-to-text tool. The provider comes from /pix → Voice or the
 * `provider` argument; the result names the provider and model that ran.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import { validateOutputPath } from "@xynogen/pix-runtime/safe-path";
import { runToolExecution } from "@xynogen/pix-runtime/tool-execution";
import { Type } from "typebox";
import { voiceConfig, voiceModel } from "./config.ts";
import { resolveProvider } from "./providers.ts";
import { makeRenderCall, makeRenderResult } from "./render.ts";

const CHAT_TRUNCATE_LIMIT = 50_000; // only when no output_file is provided

type TranscribeOutcome = "running" | "success" | "cancelled" | "error";

export interface TranscribeResultDetails {
	_type: "transcribeResult";
	outcome: TranscribeOutcome;
	file: string;
	model: string;
	language?: string;
	provider: string;
	chars?: number;
	truncated?: boolean;
	output_path?: string;
	write_error?: string;
}

interface TranscribeResult {
	content: { type: "text"; text: string }[];
	details: TranscribeResultDetails;
	isError?: boolean;
}

/** Resolve a possibly-relative `output_file` to an absolute path. */
export function resolveOutputPath(outputFile: string): string {
	return isAbsolute(outputFile) ? outputFile : resolve(process.cwd(), outputFile);
}

/** Write transcription text to disk, creating parent directories as needed.
 *  Performs pre-flight safety checks; throws on rejection. */
export async function writeTranscriptionFile(
	outputFile: string,
	text: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const abs = resolveOutputPath(outputFile);
	const validation = await validateOutputPath(abs);
	if (!validation.ok) {
		throw new Error(`output_file rejected: ${validation.reason}`);
	}
	signal?.throwIfAborted();
	await mkdir(dirname(abs), { recursive: true });
	signal?.throwIfAborted();
	await writeFile(abs, text, "utf-8");
	return abs;
}

/**
 * Build the tool return value from a successful transcription.
 * - If `outputFile` is set: write the full text verbatim and return a short summary.
 * - Otherwise: return the text inline, truncated to fit chat.
 */
export async function buildTranscriptionResult(
	text: string,
	model: string,
	provider: string,
	outputFile: string | undefined,
	file = "audio",
	language?: string,
	signal?: AbortSignal,
): Promise<TranscribeResult> {
	signal?.throwIfAborted();
	const details: TranscribeResultDetails = {
		_type: "transcribeResult",
		outcome: "success",
		file,
		model,
		...(language ? { language } : {}),
		provider,
		chars: text.length,
		truncated: !outputFile && text.length > CHAT_TRUNCATE_LIMIT,
	};

	if (outputFile) {
		try {
			const abs = await writeTranscriptionFile(outputFile, text, signal);
			details.output_path = abs;
			return {
				content: [
					{
						type: "text",
						text: `Transcribed ${text.length} chars → ${abs}`,
					},
				],
				details,
			};
		} catch (writeErr) {
			signal?.throwIfAborted();
			const msg = getErrorMessage(writeErr);
			details.outcome = "error";
			details.truncated = text.length > CHAT_TRUNCATE_LIMIT;
			details.write_error = msg;
			return {
				content: [
					{
						type: "text",
						text: `Transcription succeeded but writing to ${outputFile} failed: ${msg}\nThe transcribed text is included below — consider writing it to a different path.`,
					},
					{ type: "text", text: text.slice(0, CHAT_TRUNCATE_LIMIT) },
				],
				details,
				isError: true,
			};
		}
	}

	return {
		content: [{ type: "text", text: text.slice(0, CHAT_TRUNCATE_LIMIT) }],
		details,
	};
}

/** Transcribe with the saved default provider and model. Used by /stt. */
export async function transcribeAudioFile(
	file: string,
	signal?: AbortSignal,
): Promise<{ text: string; provider: string; model: string; language?: string }> {
	signal?.throwIfAborted();
	const provider = resolveProvider("stt", voiceConfig.sttProvider);
	const model = voiceModel("stt", provider);
	const language = voiceConfig.sttLanguage === "auto" ? undefined : voiceConfig.sttLanguage;
	const text = await provider.transcribe({ file, model, language, signal });
	signal?.throwIfAborted();
	return { text, provider: provider.id, model, language };
}

function compactChars(chars: number | undefined): string {
	const value = chars ?? 0;
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export default function registerTranscribe(pi: ExtensionAPI): void {
	const renderTerminal = makeRenderResult<TranscribeResultDetails>({
		tool: "transcribe",
		target: (details) => basename(details.file),
		meta: (details) => {
			if (details.write_error) return "write failed · transcript preserved inline";
			if (details.outcome === "error") return "failed";
			if (details.outcome === "cancelled") return "cancelled";
			const chars = `${compactChars(details.chars)} chars`;
			return details.output_path
				? `${chars} · wrote ${basename(details.output_path)}`
				: `${chars} · ${details.provider}/${details.model}`;
		},
		status: (details) =>
			details.outcome === "error"
				? "error"
				: details.outcome === "cancelled"
					? "warning"
					: "success",
	});

	pi.registerTool({
		name: "transcribe",
		...({ exposure: "deferred" } as const),
		label: "Transcribe",
		renderShell: "self",
		description: "Transcribe an audio file to text through the configured voice provider.",
		promptSnippet: "transcribe(file, output_file?, language?)",
		renderCall: makeRenderCall("transcribe", (args) => basename(String(args.file ?? ""))),
		renderResult: (result, options, theme, context) =>
			renderTerminal(result, options, theme, {
				...context,
				// Structured transcription failures have safe metadata for a compact
				// terminal row; expansion still restores the exact returned blocks.
				isError: context.isError && options.expanded,
			}),
		parameters: Type.Object({
			file: Type.String({ description: "Audio file path" }),
			output_file: Type.Optional(
				Type.String({
					description:
						"Write the full text here and return only a summary (default: inline, max 50000 chars)",
				}),
			),
			language: Type.Optional(Type.String({ description: "ISO 639-1 code, e.g. en" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const filePath = params.file;
			const base = {
				_type: "transcribeResult" as const,
				file: filePath,
				provider: voiceConfig.sttProvider,
				model: "",
				...(params.language ? { language: params.language } : {}),
			};
			return runToolExecution({
				signal,
				onUpdate,
				onError: (error, cancelled) => ({
					content: [
						{
							type: "text" as const,
							text: cancelled
								? "Transcription cancelled."
								: `Transcription failed (${base.provider}/${base.model}): ${getErrorMessage(error)}`,
						},
					],
					details: { ...base, outcome: cancelled ? ("cancelled" as const) : ("error" as const) },
					isError: !cancelled,
				}),
				execute: async ({ update }) => {
					const provider = resolveProvider("stt", voiceConfig.sttProvider);
					const model = voiceModel("stt", provider);
					Object.assign(base, { provider: provider.id, model });
					update({
						content: [
							{ type: "text", text: `Transcribing ${filePath} with ${provider.id}/${model}...` },
						],
						details: { ...base, outcome: "running" },
					});
					signal?.throwIfAborted();
					const text = await provider.transcribe({
						file: filePath,
						model,
						language: params.language,
						signal,
					});
					signal?.throwIfAborted();
					return await buildTranscriptionResult(
						text,
						model,
						provider.id,
						params.output_file,
						filePath,
						params.language,
						signal,
					);
				},
			});
		},
	});
}
