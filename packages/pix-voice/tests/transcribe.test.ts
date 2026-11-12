import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tempDir } from "@xynogen/pix-runtime/paths";

import { mimeType, parseTranscriptionResponse } from "../src/http.ts";
import registerTranscribe, {
	buildTranscriptionResult,
	resolveOutputPath,
	writeTranscriptionFile,
} from "../src/transcribe.ts";

/** Blocked on every OS: pix-runtime/safe-path rejects ~/.ssh. */
const SECRET = join(homedir(), ".ssh", "authorized_keys");

// ── mimeType ─────────────────────────────────────────────────────────────────

describe("mimeType", () => {
	it("returns audio/mpeg for .mp3", () => {
		expect(mimeType("recording.mp3")).toBe("audio/mpeg");
	});

	it("returns audio/mpeg for .mpga", () => {
		expect(mimeType("recording.mpga")).toBe("audio/mpeg");
	});

	it("returns audio/wav for .wav", () => {
		expect(mimeType("recording.wav")).toBe("audio/wav");
	});

	it("returns audio/flac for .flac", () => {
		expect(mimeType("music.flac")).toBe("audio/flac");
	});

	it("returns audio/ogg for .ogg", () => {
		expect(mimeType("voice.ogg")).toBe("audio/ogg");
	});

	it("returns audio/mp4 for .m4a", () => {
		expect(mimeType("podcast.m4a")).toBe("audio/mp4");
	});

	it("returns audio/webm for .webm", () => {
		expect(mimeType("clip.webm")).toBe("audio/webm");
	});

	it("returns audio/mp4 for .mp4", () => {
		expect(mimeType("video.mp4")).toBe("audio/mp4");
	});

	it("is case-insensitive on extension", () => {
		expect(mimeType("LOUD.MP3")).toBe("audio/mpeg");
		expect(mimeType("file.WAV")).toBe("audio/wav");
		expect(mimeType("track.Flac")).toBe("audio/flac");
	});

	it("returns application/octet-stream for unknown extension", () => {
		expect(mimeType("archive.zip")).toBe("application/octet-stream");
	});

	it("returns application/octet-stream for no extension", () => {
		expect(mimeType("noext")).toBe("application/octet-stream");
	});

	it("handles paths with directories", () => {
		expect(mimeType("/home/user/audio/meeting.mp3")).toBe("audio/mpeg");
		expect(mimeType("./recordings/call.wav")).toBe("audio/wav");
	});

	it("handles dotfiles with audio extensions", () => {
		expect(mimeType(".hidden.mp3")).toBe("audio/mpeg");
	});
});

// ── parseTranscriptionResponse ───────────────────────────────────────────────

describe("parseTranscriptionResponse", () => {
	it("extracts text from JSON response", () => {
		const raw = JSON.stringify({ text: "Hello, world!" });
		expect(parseTranscriptionResponse(raw)).toBe("Hello, world!");
	});

	it("extracts text from JSON with extra fields", () => {
		const raw = JSON.stringify({
			text: "Transcribed content",
			duration: 5.2,
			language: "en",
		});
		expect(parseTranscriptionResponse(raw)).toBe("Transcribed content");
	});

	it("returns raw JSON string when text field is missing", () => {
		const raw = JSON.stringify({ result: "no text field" });
		expect(parseTranscriptionResponse(raw)).toBe(raw);
	});

	it("returns plain text as-is when not JSON", () => {
		expect(parseTranscriptionResponse("Just plain text")).toBe("Just plain text");
	});

	it("returns empty string from JSON with empty text", () => {
		const raw = JSON.stringify({ text: "" });
		// ?? only triggers on null/undefined, not empty string — so "" is returned
		expect(parseTranscriptionResponse(raw)).toBe("");
	});

	it("returns raw when text is null", () => {
		const raw = JSON.stringify({ text: null });
		// null ?? raw → raw
		expect(parseTranscriptionResponse(raw)).toBe(raw);
	});

	it("returns raw when text is undefined (absent from parsed object)", () => {
		const raw = JSON.stringify({ other: "stuff" });
		// parsed.text is undefined → undefined ?? raw → raw
		expect(parseTranscriptionResponse(raw)).toBe(raw);
	});

	it("handles multiline transcription", () => {
		const text = "Line one.\nLine two.\nLine three.";
		const raw = JSON.stringify({ text });
		expect(parseTranscriptionResponse(raw)).toBe(text);
	});

	it("handles unicode in transcription", () => {
		const text = "日本語のテスト 🎙️";
		const raw = JSON.stringify({ text });
		expect(parseTranscriptionResponse(raw)).toBe(text);
	});

	it("handles broken JSON gracefully", () => {
		expect(parseTranscriptionResponse("{broken")).toBe("{broken");
	});

	it("handles empty string input", () => {
		expect(parseTranscriptionResponse("")).toBe("");
	});
});

// ── resolveOutputPath ────────────────────────────────────────────────────────

describe("resolveOutputPath", () => {
	it("keeps absolute paths as-is", () => {
		const abs = join(tempDir(), "foo", "bar.txt");
		expect(resolveOutputPath(abs)).toBe(abs);
	});

	it("resolves relative paths against cwd", () => {
		const rel = join("transcripts", "out.txt");
		const result = resolveOutputPath(rel);
		expect(result.endsWith(rel)).toBe(true);
		expect(result.startsWith(process.cwd())).toBe(true);
	});
});

// ── writeTranscriptionFile ───────────────────────────────────────────────────

describe("writeTranscriptionFile", () => {
	const tmpRoot = mkdtempSync(join(tempDir(), "pix-transcribe-test-"));

	it("writes text to the given file path", async () => {
		const file = join(tmpRoot, "simple.txt");
		const abs = await writeTranscriptionFile(file, "hello world");
		expect(abs).toBe(file);
		expect(await readFile(file, "utf-8")).toBe("hello world");
	});

	it("creates parent directories recursively", async () => {
		const file = join(tmpRoot, "deep", "nested", "dir", "out.txt");
		const abs = await writeTranscriptionFile(file, "deep content");
		expect(abs).toBe(file);
		expect(await readFile(file, "utf-8")).toBe("deep content");
	});

	it("preserves full unicode without truncation", async () => {
		const text = `日本語のテスト\n${"x".repeat(100_000)}`;
		const file = join(tmpRoot, "huge.txt");
		await writeTranscriptionFile(file, text);
		const got = await readFile(file, "utf-8");
		expect(got.length).toBe(text.length);
		expect(got).toBe(text);
	});

	it("overwrites an existing file", async () => {
		const file = join(tmpRoot, "overwrite.txt");
		await writeTranscriptionFile(file, "first");
		await writeTranscriptionFile(file, "second");
		expect(await readFile(file, "utf-8")).toBe("second");
	});

	// cleanup tmp root
	it("cleanup", async () => {
		await rm(tmpRoot, { recursive: true, force: true });
	});
});

// ── buildTranscriptionResult ─────────────────────────────────────────────────

describe("buildTranscriptionResult", () => {
	const tmpRoot = mkdtempSync(join(tempDir(), "pix-transcribe-result-"));

	it("returns inline text (truncated at 50_000) when no output_file is set", async () => {
		const text = "a".repeat(60_000);
		const result = await buildTranscriptionResult(text, "dg/nova-3", "9router", undefined);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]?.text.length).toBe(50_000);
		expect(result.details).toMatchObject({
			_type: "transcribeResult",
			outcome: "success",
			model: "dg/nova-3",
			provider: "9router",
			chars: 60_000,
			truncated: true,
		});
	});

	it("returns inline text (untruncated) when short and no output_file", async () => {
		const text = "short transcript";
		const result = await buildTranscriptionResult(text, "dg/nova-3", "9router", undefined);
		expect(result.content[0]?.text).toBe("short transcript");
		expect(result.details.chars).toBe(text.length);
	});

	it("writes full text to file and returns short path summary when output_file is set", async () => {
		const text = "a".repeat(100_000); // way over 50k
		const file = join(tmpRoot, "result-a.txt");
		const result = await buildTranscriptionResult(text, "dg/nova-3", "9router", file);

		// content is a short summary, not the full text
		expect(result.content).toHaveLength(1);
		const summary = result.content[0]?.text ?? "";
		expect(summary.length).toBeLessThan(200);
		expect(summary).toContain("100000");
		expect(summary).toContain(file);

		// full text was written verbatim
		const onDisk = await readFile(file, "utf-8");
		expect(onDisk.length).toBe(100_000);
		expect(onDisk).toBe(text);

		// details includes resolved absolute path
		expect(result.details.output_path).toBe(file);
		expect(result.details.chars).toBe(100_000);
		expect(result.details.provider).toBe("9router");
	});

	it("names the provider that ran", async () => {
		const result = await buildTranscriptionResult("hi", "whisper-1", "openai", undefined);
		expect(result.details).toMatchObject({ provider: "openai", model: "whisper-1" });
	});

	it("relative output_file is resolved against cwd and created", async () => {
		const text = "relative path content";
		const relDir = join(tmpRoot, "rel", "sub");
		const relFile = join(relDir, "out.txt");
		const result = await buildTranscriptionResult(text, "dg/nova-3", "9router", relFile);

		expect(result.details.output_path).toBe(relFile);
		expect(await readFile(relFile, "utf-8")).toBe("relative path content");
	});

	it("cleanup", async () => {
		await rm(tmpRoot, { recursive: true, force: true });
	});
});

// ── writeTranscriptionFile — rejection propagation ───────────────────────────

describe("writeTranscriptionFile — rejection propagation", () => {
	it("throws on sensitive prefix", async () => {
		await expect(writeTranscriptionFile(SECRET, "x")).rejects.toThrow(/refusing to write under /);
	});

	it("throws on null byte", async () => {
		await expect(writeTranscriptionFile(join(tempDir(), "pix-test-\0x.txt"), "x")).rejects.toThrow(
			/null byte/,
		);
	});
});

// ── buildTranscriptionResult — write failure path ───────────────────────────

describe("buildTranscriptionResult — write failure path", () => {
	it("returns isError + inline fallback when output_file is rejected", async () => {
		const text = "the actual transcription that was successfully produced";
		const result = await buildTranscriptionResult(
			text,
			"dg/nova-3",
			"9router",
			SECRET,
			"meeting.mp3",
		);
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			_type: "transcribeResult",
			outcome: "error",
			file: "meeting.mp3",
			write_error: expect.stringMatching(/refusing to write/),
		});
		expect(result.details.output_path).toBeUndefined();
		// both blocks, including the recovered transcript, remain available to the model
		expect(result.content).toHaveLength(2);
		const joined = result.content.map((c) => c.text).join("\n");
		expect(joined).toContain(text);
		expect(joined).toContain(SECRET);
	});
});

const theme = {
	fg: (token: string, text: string) => `[${token}]${text}`,
	bold: (text: string) => `*${text}*`,
} as never;

function captureTranscribeRenderer() {
	let tool: Record<string, unknown> | undefined;
	registerTranscribe({
		registerTool(value: Record<string, unknown>) {
			tool = value;
		},
	} as never);
	if (!tool) throw new Error("transcribe tool was not registered");
	return tool;
}

function renderTranscribe(
	result: Record<string, unknown>,
	expanded = false,
	isError = false,
): string {
	let text = "";
	const component = {
		setText(value: string) {
			text = value;
		},
		render: () => [],
		invalidate: () => {},
	};
	const tool = captureTranscribeRenderer();
	const renderResult = tool.renderResult as ((...args: never[]) => unknown) | undefined;
	renderResult?.(result as never, { expanded, isPartial: false } as never, theme, {
		lastComponent: component,
		isError,
		state: { collapsed: true },
		expanded,
		invalidate: () => {},
	} as never);
	return text;
}

describe("transcribe compact renderer", () => {
	it("uses the self-rendered shell so the status mark has no leading box padding", () => {
		expect(captureTranscribeRenderer().renderShell).toBe("self");
	});

	it("summarizes inline and written transcripts", () => {
		const inline = renderTranscribe({
			content: [{ type: "text", text: "full transcript" }],
			details: {
				_type: "transcribeResult",
				outcome: "success",
				file: "/recordings/meeting.mp3",
				model: "dg/nova-3",
				provider: "9router",
				chars: 12_400,
				truncated: false,
			},
		});
		expect(inline).toContain("✓");
		expect(inline).toContain("meeting.mp3");
		expect(inline).toContain("12.4K chars · 9router/dg/nova-3");

		const written = renderTranscribe({
			content: [{ type: "text", text: "Transcribed 12400 chars → /tmp/notes.md" }],
			details: {
				_type: "transcribeResult",
				outcome: "success",
				file: "/recordings/meeting.mp3",
				model: "dg/nova-3",
				provider: "9router",
				chars: 12_400,
				truncated: false,
				output_path: "/tmp/notes.md",
			},
		});
		expect(written).toContain("12.4K chars · wrote notes.md");
	});

	it("summarizes write failure and restores both exact blocks when expanded", () => {
		const result = {
			content: [
				{ type: "text", text: "Writing failed: permission denied" },
				{ type: "text", text: "recovered transcript" },
			],
			details: {
				_type: "transcribeResult",
				outcome: "error",
				file: "/recordings/meeting.mp3",
				model: "dg/nova-3",
				provider: "9router",
				chars: 20,
				truncated: false,
				write_error: "permission denied",
			},
		};
		const compact = renderTranscribe(result, false, true);
		expect(compact).toContain("✗");
		expect(compact).toContain("write failed · transcript preserved inline");

		const expanded = renderTranscribe(result, true, true);
		expect(expanded).toContain("Writing failed: permission denied");
		expect(expanded).toContain("recovered transcript");
	});
});
