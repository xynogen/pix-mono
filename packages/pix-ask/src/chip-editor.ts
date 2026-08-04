/**
 * chip-editor — a freeform Editor for the questionnaire that renders paste
 * chips like the main Pi prompt does.
 *
 *   long pasted text            →  buffer:  [paste #1 +42 lines]
 *                                  display: 󰉿 text 42 lines
 *   pasted image path           →  buffer:  [paste #2 58 chars]
 *                                  display: 󰋩 image #2
 *
 * The base `pi-tui` Editor already collapses large text pastes (>10 lines or
 * >1000 chars) into `[paste #N …]` markers and expands them back to their full
 * content on submit. This subclass adds two things on top:
 *
 *   1. Image-path detection — a pasted/typed image path becomes its own paste
 *      marker so it deletes atomically and shows an image chip. On submit it
 *      expands back to the raw path (a reference the model can read), matching
 *      pix-display's clipboard-image behavior.
 *   2. Display restyle — every `[paste #N …]` marker is re-rendered as a
 *      colored icon chip. Purely visual; the buffer is untouched.
 *
 * This duplicates the small helpers from pix-display's ChipEditor rather than
 * adding a cross-package dependency (repo policy prefers duplication).
 */

import {
	Editor,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { BOLD, FG_BLUE, FG_DIM, FG_GREEN, RST } from "@xynogen/pix-pretty/ansi";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { readClipboardImageToFile } from "./clipboard-image.js";

// ─── Constants ──────────────────────────────────────────────────────────────

// Boundary wrapper injected around each expanded paste so the model sees an
// explicit start/end per blob instead of adjacent pastes merged into one wall.
// Applies to text and image pastes alike.
const PASTE_OPEN = "<paste>";
const PASTE_CLOSE = "</paste>";

const IMAGE_EXTS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".tif",
	".tiff",
	".heic",
	".heif",
]);

// Group 1 = prefix char (or empty at start), Group 2 = path.
const PATH_RE = /(^|[^\w/])((?:~|\/)[^\s,;'"(){}[\]]+)/g;

// Pi's marker grammar — must match exactly for atomic segmentation.
const MARKER_RE = /\[paste #(\d+)( (\+(\d+) lines|(\d+) chars))?\]/g;
// Cursor inversion codes the Editor embeds when the cursor intersects a marker.
const CURSOR_RE = /\x1b\[[0-9;]*m/g;
// A `[…]` span that starts with `paste #` and may carry interleaved cursor SGR.
const MARKER_SPAN_RE =
	/(?:\x1b\[[0-9;]*m)*\[(?:\x1b\[[0-9;]*m)*paste #(?:[^\]]|\x1b\[[0-9;]*m)*\]/g;

// ─── Helpers (duplicated from pix-display/paste-chips) ───────────────────────

function extOf(p: string): string {
	const dot = p.lastIndexOf(".");
	return dot >= 0 ? p.slice(dot).toLowerCase() : "";
}

function isImagePath(p: string): boolean {
	return IMAGE_EXTS.has(extOf(p));
}

function makeMarker(id: number, charCount: number): string {
	return `[paste #${id} ${charCount} chars]`;
}

/** True when `text` ends with a Pi paste marker (chip). */
export function endsWithMarker(text: string): boolean {
	return /\[paste #\d+[^\]]*\]$/.test(text);
}

/** Mirror of the base Editor's paste-marker grammar, scoped to one id. */
function markerReFor(pasteId: number): RegExp {
	// pasteId is a numeric Map key; coerce to an integer literal so the pattern
	// is provably digits-only (no injection / ReDoS surface).
	const id = Math.trunc(pasteId);
	return new RegExp(`\\[paste #${id}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
}

/**
 * Expand every paste marker in `text` to its content wrapped in
 * `<paste>…</paste>`. Mirrors the base Editor's expansion loop but adds a
 * boundary per blob (text and image alike) so adjacent pastes can't merge into
 * one indistinguishable wall in the model-facing text.
 */
export function expandPasteMarkers(text: string, pastes: Map<number, string>): string {
	let result = text;
	for (const [pasteId, pasteContent] of pastes) {
		result = result.replace(
			markerReFor(pasteId),
			() => `${PASTE_OPEN}${pasteContent}${PASTE_CLOSE}`,
		);
	}
	return result;
}

function compactNumber(raw: string): string {
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return raw;
	if (n < 1_000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

type EditorInternals = {
	pastes: Map<number, string>;
	pasteCounter: number;
};

/**
 * Walk `text`; for each image path allocate a new paste ID, register the real
 * path in editor.pastes, remember the ID as an image, and emit a Pi-format
 * marker so deletion is atomic and the display shows an image chip.
 */
export function replaceImagePaths(
	text: string,
	internals: EditorInternals,
	imageIds: Set<number>,
): string {
	return text.replace(PATH_RE, (_, prefix: string, rawPath: string) => {
		if (!isImagePath(rawPath)) return prefix + rawPath;
		internals.pasteCounter += 1;
		const id = internals.pasteCounter;
		internals.pastes.set(id, rawPath);
		imageIds.add(id);
		return prefix + makeMarker(id, rawPath.length);
	});
}

/**
 * Re-style every paste marker in a rendered line:
 *   image → `󰋩 image #N` (blue), text → `󰉿 text N lines/chars` (green).
 * Width-preserving is not required — the Editor re-wraps each render call.
 */
export function restyleMarkers(line: string, imageIds: Set<number>): string {
	return line.replace(MARKER_SPAN_RE, (span) => {
		const clean = span.includes("\x1b") ? span.replace(CURSOR_RE, "") : span;
		MARKER_RE.lastIndex = 0;
		const m = MARKER_RE.exec(clean);
		if (!m?.[1]) return span;
		const [, idStr, , , linesStr, charsStr] = m;
		const id = Number.parseInt(idStr, 10);
		if (imageIds.has(id)) {
			return chip(FG_BLUE, icon("paste.image"), "image", `#${id}`);
		}
		if (linesStr) {
			return chip(FG_GREEN, icon("paste.text"), "text", `${linesStr} lines`);
		}
		if (charsStr) {
			return chip(FG_GREEN, icon("paste.text"), "text", `${compactNumber(charsStr)} chars`);
		}
		return chip(FG_GREEN, icon("paste.text"), "text", `#${id}`);
	});
}

function chip(color: string, glyph: string, label: string, meta: string): string {
	return `${color}${BOLD}${glyph} ${label}${RST}${FG_DIM} ${meta}${RST}`;
}

// ─── ChipEditor ──────────────────────────────────────────────────────────────

/**
 * Editor subclass for the questionnaire freeform row. Text pastes are collapsed
 * to badges by the base class; image paths become image chips here. Both expand
 * to their real content/path on submit via the base `submitValue`.
 */
export class ChipEditor extends Editor {
	private readonly imageIds = new Set<number>();

	constructor(tui: TUI, theme: EditorTheme) {
		super(tui, theme);
		this.patchHandlePaste();
		this.patchExpandPasteMarkers();
		this.patchSubmitValue();
	}

	/**
	 * Patch `expandPasteMarkers` (TS-private on the base Editor, runtime-public
	 * JS) so every paste expands to its content wrapped in `<paste>…</paste>`.
	 * The base inlines content raw, letting adjacent pastes merge into one
	 * indistinguishable wall; the boundary gives the model an explicit start/end
	 * per blob — text and image path alike.
	 */
	private patchExpandPasteMarkers(): void {
		const internals = this as unknown as EditorInternals;
		const self = this as unknown as { expandPasteMarkers(text: string): string };
		self.expandPasteMarkers = (text: string): string => expandPasteMarkers(text, internals.pastes);
	}

	override insertTextAtCursor(text: string): void {
		const internals = this as unknown as EditorInternals;
		const replaced = replaceImagePaths(text, internals, this.imageIds);
		// Land the cursor after the chip, not inside it.
		super.insertTextAtCursor(endsWithMarker(replaced) ? `${replaced} ` : replaced);
	}

	private patchHandlePaste(): void {
		const self = this as unknown as { handlePaste(text: string): void };
		const base = self.handlePaste.bind(self);
		self.handlePaste = (pastedText: string) => {
			const before = this.getText();
			base(pastedText);
			const after = this.getText();
			if (endsWithMarker(after) && after !== before) {
				super.insertTextAtCursor(" ");
			}
		};
	}

	private patchSubmitValue(): void {
		const self = this as unknown as { submitValue(): void };
		const base = self.submitValue.bind(self);
		self.submitValue = () => {
			// The base resets pasteCounter to zero in submitValue; clear the
			// parallel image-ID registry in the same operation before reuse.
			this.imageIds.clear();
			base();
		};
	}

	/**
	 * Intercept Ctrl+V for clipboard-image capture before the base Editor sees
	 * it. The questionnaire runs as an overlay, so Pi's app-level paste-image
	 * handler never fires here; we replicate it. On an image hit we spill the
	 * bytes to a temp file and insert its path, which `insertTextAtCursor` turns
	 * into an image chip. No image (or non-Linux, no tool) → fall through so the
	 * base Editor handles Ctrl+V as ordinary input / text paste.
	 */
	override handleInput(data: string): void {
		// Ctrl+V — single 0x16 byte (win32 uses Alt+V, unreachable in this TUI).
		if (data === "\x16") {
			const filePath = readClipboardImageToFile();
			if (filePath) {
				this.insertTextAtCursor(filePath);
				return;
			}
		}
		super.handleInput(data);
	}

	override render(width: number): string[] {
		const raw = super.render(width);
		return raw.map((line) => {
			const restyled = restyleMarkers(line, this.imageIds);
			if (visibleWidth(restyled) > width) {
				return truncateToWidth(restyled, width, "");
			}
			return restyled;
		});
	}
}
