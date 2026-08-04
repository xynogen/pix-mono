/**
 * chip-editor.test.ts — pure-function tests for paste-chip rendering and
 * image-path marker rewriting used by the questionnaire freeform editor.
 *
 * The TUI ChipEditor class is not instantiated here (needs a live TUI); we test
 * the exported helpers that carry the actual logic.
 */

import { describe, expect, test } from "bun:test";
import {
	endsWithMarker,
	expandPasteMarkers,
	replaceImagePaths,
	restyleMarkers,
} from "./chip-editor.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// ── endsWithMarker ────────────────────────────────────────────────────

describe("endsWithMarker", () => {
	test("true for a trailing chars marker", () => {
		expect(endsWithMarker("hello [paste #1 58 chars]")).toBe(true);
	});
	test("true for a trailing lines marker", () => {
		expect(endsWithMarker("[paste #2 +42 lines]")).toBe(true);
	});
	test("false when marker is not at the end", () => {
		expect(endsWithMarker("[paste #1 58 chars] more")).toBe(false);
	});
	test("false for plain text", () => {
		expect(endsWithMarker("just text")).toBe(false);
	});
});

// ── replaceImagePaths ─────────────────────────────────────────────────

describe("replaceImagePaths", () => {
	const fresh = () => ({ pastes: new Map<number, string>(), pasteCounter: 0 });

	test("image path becomes a paste marker and registers as image", () => {
		const internals = fresh();
		const imageIds = new Set<number>();
		const out = replaceImagePaths("/tmp/pic.png", internals, imageIds);
		expect(out).toBe("[paste #1 12 chars]");
		expect(internals.pastes.get(1)).toBe("/tmp/pic.png");
		expect(imageIds.has(1)).toBe(true);
	});

	test("non-image path is left untouched", () => {
		const internals = fresh();
		const imageIds = new Set<number>();
		const out = replaceImagePaths("/etc/hosts", internals, imageIds);
		expect(out).toBe("/etc/hosts");
		expect(imageIds.size).toBe(0);
	});

	test("multiple image paths get sequential ids", () => {
		const internals = fresh();
		const imageIds = new Set<number>();
		const out = replaceImagePaths("~/a.jpg and /b/c.webp", internals, imageIds);
		expect(out).toBe("[paste #1 7 chars] and [paste #2 9 chars]");
		expect([...imageIds].sort()).toEqual([1, 2]);
	});
});

// ── expandPasteMarkers (<paste> boundary) ─────────────────────────────

describe("expandPasteMarkers", () => {
	test("text paste expands wrapped in <paste>…</paste>", () => {
		const pastes = new Map<number, string>([[1, "line1\nline2\nblob"]]);
		const out = expandPasteMarkers("before [paste #1 +12 lines] after", pastes);
		expect(out).toBe("before <paste>line1\nline2\nblob</paste> after");
	});

	test("image path paste expands wrapped in <paste>…</paste>", () => {
		const internals = { pastes: new Map<number, string>(), pasteCounter: 0 };
		const imageIds = new Set<number>();
		const withMarker = replaceImagePaths("/tmp/shot.png", internals, imageIds);
		const out = expandPasteMarkers(withMarker, internals.pastes);
		expect(out).toBe("<paste>/tmp/shot.png</paste>");
	});

	test("adjacent pastes stay separated by their own boundaries", () => {
		const pastes = new Map<number, string>([
			[1, "AAA"],
			[2, "BBB"],
		]);
		const out = expandPasteMarkers("[paste #1 3 chars][paste #2 3 chars]", pastes);
		expect(out).toBe("<paste>AAA</paste><paste>BBB</paste>");
	});

	test("text without markers passes through unchanged", () => {
		const out = expandPasteMarkers("plain text", new Map());
		expect(out).toBe("plain text");
	});
});

// ── restyleMarkers ────────────────────────────────────────────────────

describe("restyleMarkers", () => {
	test("chars marker → text chip", () => {
		const out = restyleMarkers("[paste #1 2232 chars]", new Set());
		expect(stripAnsi(out)).toContain("text");
		expect(stripAnsi(out)).toContain("2.2k chars");
	});

	test("lines marker → text chip", () => {
		const out = restyleMarkers("[paste #2 +42 lines]", new Set());
		expect(stripAnsi(out)).toContain("text");
		expect(stripAnsi(out)).toContain("42 lines");
	});

	test("image id → image chip", () => {
		const out = restyleMarkers("[paste #1 58 chars]", new Set([1]));
		expect(stripAnsi(out)).toContain("image");
		expect(stripAnsi(out)).toContain("#1");
	});

	test("non-image id is not styled as image", () => {
		const out = restyleMarkers("[paste #2 100 chars]", new Set([1]));
		expect(stripAnsi(out)).toContain("text");
		expect(stripAnsi(out)).not.toContain("image");
	});

	test("plain text passes through unchanged", () => {
		const line = "just regular text with no paste markers";
		expect(restyleMarkers(line, new Set())).toBe(line);
	});
});
