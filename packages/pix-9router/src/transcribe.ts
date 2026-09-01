/**
 * transcribe.ts — speech-to-text tool via 9Router audio transcription API, with curl fallback.
 *
 * Uses the OpenAI-compatible /audio/transcriptions endpoint through the router.
 * Accepts a file path to an audio file and returns the transcribed text.
 *
 * Default model: dg/nova-3 (Deepgram Nova 3)
 *
 * Environment:
 *   ROUTER_API_BASE  — router API base URL (default: https://9router.example.com/v1)
 *   ROUTER_API_KEY   — bearer token for the router
 */

import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ioTimeoutSignal } from "@xynogen/pix-runtime/io";
import { Type } from "typebox";
import { routerBaseUrl } from "./data.js";
import { auth, curl } from "./http.js";
import { makeRenderCall, makeRenderResult } from "./render.js";

const CHAT_TRUNCATE_LIMIT = 50_000; // only when no output_file is provided
const DEFAULT_MODEL = "dg/nova-3";

type TranscribeOutcome = "running" | "success" | "cancelled" | "error";

export interface TranscribeResultDetails {
	_type: "transcribeResult";
	outcome: TranscribeOutcome;
	file: string;
	model: string;
	language?: string;
	source?: "api" | "curl-fallback" | "failed";
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

/** Map file extension to MIME type for common audio formats. */
export function mimeType(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	const types: Record<string, string> = {
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
		".flac": "audio/flac",
		".ogg": "audio/ogg",
		".m4a": "audio/mp4",
		".webm": "audio/webm",
		".mp4": "audio/mp4",
		".mpga": "audio/mpeg",
	};
	return types[ext] ?? "application/octet-stream";
}

async function apiMultipart(
	path: string,
	filePath: string,
	model: string,
	language: string | undefined,
	signal?: AbortSignal,
): Promise<string> {
	const url = `${routerBaseUrl()}${path}`;
	const key = auth();
	const requestSignal = ioTimeoutSignal(signal);
	const fileData = await readFile(filePath, { signal: requestSignal });
	const blob = new Blob([fileData], { type: mimeType(filePath) });

	const form = new FormData();
	form.append("file", blob, basename(filePath));
	form.append("model", model);
	if (language) form.append("language", language);

	const res = await fetch(url, {
		method: "POST",
		headers: {
			...(key ? { Authorization: `Bearer ${key}` } : {}),
		},
		body: form,
		signal: requestSignal,
	});
	if (!res.ok) {
		const errText = await res.text().catch(() => "");
		throw new Error(`API ${res.status}: ${errText.slice(0, 500)}`);
	}
	return res.text();
}

/** Extract the `text` field from a JSON envelope, or return the raw string. */
export function parseTranscriptionResponse(raw: string): string {
	try {
		const parsed = JSON.parse(raw) as { text?: string };
		return parsed.text ?? raw;
	} catch {
		return raw;
	}
}

/** Resolve a possibly-relative `output_file` to an absolute path. */
export function resolveOutputPath(outputFile: string): string {
	return isAbsolute(outputFile) ? outputFile : resolve(process.cwd(), outputFile);
}

/**
 * Pre-flight safety check for `output_file`. Rejects paths that target sensitive
 * system locations, null bytes, non-existent or non-writable parents, symlinks
 * (at the target or anywhere in the parent chain), and existing-directory targets.
 *
 * Returns a discriminated result so the caller can surface a precise reason to
 * the model without leaking OS internals.
 */
export type PathValidation = { ok: true; path: string } | { ok: false; reason: string };

/** Block-list of absolute prefixes that should never receive transcription output. */
function sensitivePrefixes(): string[] {
	const home = homedir();
	return [
		"/etc",
		"/proc",
		"/sys",
		"/boot",
		`${home}/.ssh`,
		`${home}/.aws`,
		`${home}/.gnupg`,
		`${home}/.config/gh`,
	];
}

export async function validateOutputPath(absPath: string): Promise<PathValidation> {
	// 1. Null byte injection guard (defence in depth — Node already rejects, fail fast with clear msg)
	if (absPath.includes("\0")) {
		return { ok: false, reason: "path contains a null byte" };
	}

	// 2. Sensitive prefix block-list
	for (const prefix of sensitivePrefixes()) {
		if (absPath === prefix || absPath.startsWith(`${prefix}/`)) {
			return { ok: false, reason: `refusing to write under ${prefix}` };
		}
	}

	// 3. Target must not be a symlink and must not be an existing directory.
	//    (lstat does NOT follow symlinks — that's the whole point of using it here.)
	try {
		const st = await lstat(absPath);
		if (st.isSymbolicLink()) {
			return { ok: false, reason: `target is a symlink: ${absPath}` };
		}
		if (st.isDirectory()) {
			return {
				ok: false,
				reason: `target is an existing directory: ${absPath}`,
			};
		}
	} catch (err) {
		// ENOENT is fine — we'll create the file. Anything else is a hard fail.
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			return {
				ok: false,
				reason: `cannot stat target: ${(err as Error).message}`,
			};
		}
	}

	// 4. Walk up the parent chain. For every ancestor that EXISTS, it must
	//    (a) not be a symlink (stops /tmp/safe-looking-dir → /etc redirect), and
	//    (b) be writable so mkdir -p can create missing intermediates.
	//    Ancestors that don't exist (ENOENT) are fine — mkdir -p will create them.
	const parent = dirname(absPath);
	let cursor = parent;
	let nearestExisting: string | null = null;
	while (cursor !== dirname(cursor)) {
		let st: Awaited<ReturnType<typeof lstat>>;
		try {
			st = await lstat(cursor);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				// intermediate doesn't exist yet — keep walking up
				cursor = dirname(cursor);
				continue;
			}
			return {
				ok: false,
				reason: `cannot stat parent: ${(err as Error).message}`,
			};
		}
		if (st.isSymbolicLink()) {
			return { ok: false, reason: `parent is a symlink: ${cursor}` };
		}
		if (st.isDirectory() && nearestExisting === null) {
			nearestExisting = cursor;
		}
		cursor = dirname(cursor);
	}

	if (nearestExisting === null) {
		return {
			ok: false,
			reason: `no existing ancestor directory for ${parent}`,
		};
	}
	try {
		await access(nearestExisting, fsConstants.W_OK);
	} catch {
		return {
			ok: false,
			reason: `no writable ancestor directory: ${nearestExisting}`,
		};
	}

	return { ok: true, path: absPath };
}

/** Write transcription text to disk, creating parent directories as needed.
 *  Performs pre-flight safety checks; throws on rejection. */
export async function writeTranscriptionFile(outputFile: string, text: string): Promise<string> {
	const abs = resolveOutputPath(outputFile);
	const validation = await validateOutputPath(abs);
	if (!validation.ok) {
		throw new Error(`output_file rejected: ${validation.reason}`);
	}
	await mkdir(dirname(abs), { recursive: true });
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
	source: "api" | "curl-fallback",
	outputFile: string | undefined,
	file = "audio",
	language?: string,
): Promise<TranscribeResult> {
	const details: TranscribeResultDetails = {
		_type: "transcribeResult",
		outcome: "success",
		file,
		model,
		...(language ? { language } : {}),
		source,
		chars: text.length,
		truncated: !outputFile && text.length > CHAT_TRUNCATE_LIMIT,
	};

	if (outputFile) {
		try {
			const abs = await writeTranscriptionFile(outputFile, text);
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
			const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
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
				: `${chars} · ${details.model}`;
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
		label: "Transcribe",
		renderShell: "self",
		description:
			"Convert speech to text. Transcribes an audio file using the 9Router audio transcription API (Deepgram Nova 3). Optionally writes the full text to a file on disk.",
		promptSnippet:
			"transcribe(file, output_file?, model?, language?) — Transcribe an audio file to text. Supports mp3, wav, flac, ogg, m4a, webm. Default model: dg/nova-3. If output_file is set, the full text is written to that path (parent dirs created) and only a short path summary is returned to the model.",
		renderCall: makeRenderCall("transcribe", (args) => basename(String(args.file ?? ""))),
		renderResult: (result, options, theme, context) =>
			renderTerminal(result, options, theme, {
				...context,
				// Structured transcription failures have safe metadata for a compact
				// terminal row; expansion still restores the exact returned blocks.
				isError: context.isError && options.expanded,
			}),
		promptGuidelines: [
			"transcribe: `language` as ISO 639-1 (e.g. 'en', 'es') improves accuracy. Pass `output_file` for long results — writes full text to disk (sensitive paths/symlinks rejected; text still returned inline on rejection) and returns a path summary. Without it, text returns inline truncated to 50,000 chars.",
		],
		parameters: Type.Object({
			file: Type.String({
				description: "Path to the audio file to transcribe",
			}),
			output_file: Type.Optional(
				Type.String({
					description:
						"Write the full transcription text to this path (parent dirs are created). Relative paths resolve against cwd. When set, content returned to the model is just a short path summary.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description: "Transcription model to use (default: dg/nova-3)",
					default: DEFAULT_MODEL,
				}),
			),
			language: Type.Optional(
				Type.String({
					description: "ISO 639-1 language code (e.g. 'en', 'es', 'fr') for better accuracy",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const model = params.model ?? DEFAULT_MODEL;
			const filePath = params.file;
			const outputFile = params.output_file;
			let apiMsg = "";

			const run = async (source: "api" | "curl-fallback", raw: string) =>
				buildTranscriptionResult(
					parseTranscriptionResponse(raw),
					model,
					source,
					outputFile,
					filePath,
					params.language,
				);

			try {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Transcribing: ${filePath} (model: ${model})...`,
						},
					],
					details: {
						_type: "transcribeResult",
						outcome: "running",
						file: filePath,
						model,
						...(params.language ? { language: params.language } : {}),
					},
				});

				const raw = await apiMultipart(
					"/audio/transcriptions",
					filePath,
					model,
					params.language,
					signal,
				);

				return await run("api", raw);
			} catch (apiErr: unknown) {
				apiMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `API failed: ${apiMsg}\nFalling back to curl...`,
						},
					],
					details: undefined,
				});
			}

			// curl fallback — uses multipart form upload
			try {
				const curlArgs = [
					"-X",
					"POST",
					...(auth() ? ["-H", `Authorization: Bearer ${auth()}`] : []),
					"-F",
					`file=@${filePath}`,
					"-F",
					`model=${model}`,
					...(params.language ? ["-F", `language=${params.language}`] : []),
					`${routerBaseUrl()}/audio/transcriptions`,
				];

				const raw = await curl(curlArgs);
				return await run("curl-fallback", raw);
			} catch (curlErr: unknown) {
				const curlMsg = curlErr instanceof Error ? curlErr.message : String(curlErr);
				return {
					content: [
						{
							type: "text",
							text: `Transcription failed (both API and curl).\nAPI: ${apiMsg}\nCurl: ${curlMsg}`,
						},
					],
					details: {
						_type: "transcribeResult",
						outcome: signal?.aborted ? "cancelled" : "error",
						file: filePath,
						model,
						...(params.language ? { language: params.language } : {}),
						source: "failed",
					},
					isError: true,
				};
			}
		},
	});
}
