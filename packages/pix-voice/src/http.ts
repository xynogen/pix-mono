/** Small HTTP and audio helpers shared by the built-in providers. */

import { extname } from "node:path";
import { ioTimeoutSignal } from "@xynogen/pix-runtime/io";

export function env(name: string): string {
	return process.env[name] ?? "";
}

export function bearer(key: string): Record<string, string> {
	return key ? { Authorization: `Bearer ${key}` } : {};
}

/** fetch with the shared I/O timeout. Throws with the upstream body on a non-2xx status. */
export async function request(url: string, init: RequestInit & { signal?: AbortSignal }) {
	const response = await fetch(url, { ...init, signal: ioTimeoutSignal(init.signal) });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`${response.status}: ${body.slice(0, 500)}`);
	}
	return response;
}

export async function json(url: string, init: RequestInit & { signal?: AbortSignal }) {
	return (await (await request(url, init)).json()) as Record<string, unknown>;
}

export async function bytes(response: Response): Promise<Uint8Array> {
	const audio = new Uint8Array(await response.arrayBuffer());
	if (audio.byteLength === 0) throw new Error("the provider returned empty audio");
	return audio;
}

export function fromBase64(value: unknown): Uint8Array {
	if (typeof value !== "string" || !value) throw new Error("the provider returned no audio");
	return new Uint8Array(Buffer.from(value, "base64"));
}

/** Split "model/voice" at the last slash. A value without a slash is a model. */
export function splitModel(value: string, defaultVoice: string): { model: string; voice: string } {
	const index = value.lastIndexOf("/");
	return index > 0
		? { model: value.slice(0, index), voice: value.slice(index + 1) }
		: { model: value, voice: defaultVoice };
}

/** Map file extension to MIME type for common audio formats. */
export function mimeType(filePath: string): string {
	const types: Record<string, string> = {
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
		".flac": "audio/flac",
		".ogg": "audio/ogg",
		".m4a": "audio/mp4",
		".webm": "audio/webm",
		".mp4": "audio/mp4",
		".mpga": "audio/mpeg",
		".aac": "audio/aac",
		".opus": "audio/opus",
	};
	return types[extname(filePath).toLowerCase()] ?? "application/octet-stream";
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

/** Wrap raw 16-bit PCM in a WAV header. */
export function pcmToWav(pcm: Uint8Array, sampleRate = 24_000, channels = 1): Uint8Array {
	const header = Buffer.alloc(44);
	const byteRate = sampleRate * channels * 2;
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.byteLength, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(channels * 2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.byteLength, 40);
	return new Uint8Array(Buffer.concat([header, pcm]));
}

// ── 9Router ─────────────────────────────────────────────────────────────────

export function routerKey(): string {
	return process.env.NINEROUTER_KEY || process.env.ROUTER_API_KEY || "";
}

/** Base URL from NINEROUTER_URL / ROUTER_API_BASE, with `/v1` appended. No default: an
 * unset URL means 9Router is not configured, so callers must not send a request. */
export function routerBaseUrl(): string | undefined {
	const configured = (process.env.NINEROUTER_URL || process.env.ROUTER_API_BASE)?.trim();
	if (!configured) return undefined;
	const base = configured.replace(/\/+$/, "");
	return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function requireRouterBase(): string {
	const base = routerBaseUrl();
	if (!base) throw new Error("9Router is not configured: set NINEROUTER_URL");
	return base;
}
