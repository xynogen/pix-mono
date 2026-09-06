/**
 * inline-chips — render inline tokens in the prompt editor as compact chips.
 *
 *   long pasted text        →  buffer: [paste #1 +42 lines]     display: 󰉿 text 42 lines
 *   /tmp/shot.png           →  buffer: [paste #2 13 chars]      display: 󰋩 image #2
 *   <path>src/a.ts</path>   →  buffer: [paste #3 8 chars]       display: 󰉿 @a.ts
 *
 * `<path>…</path>` is the only contract with other extensions: pix-search
 * inserts it as text, display promotes it to an atomic Pi paste marker (one
 * backspace deletes the whole chip) and expands it back verbatim for the model.
 */
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BOLD, FG_BLUE, FG_DIM, FG_GREEN, RST } from "@xynogen/pix-pretty/ansi";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { dirIcon, fileIcon } from "@xynogen/pix-pretty/icons";

// ponytail: Pi only exposes atomic paste tokens today. Keep its private registry
// adapter here; replace this adapter when Pi provides a public inline-token API.
type Chip = { kind: "image" | "path"; path: string };
type Registry = Map<number, string | Chip>;
type PiEditor = {
	pastes: Registry;
	pasteCounter: number;
	expandPasteMarkers(text: string): string;
	handlePaste(text: string): void;
	insertTextAtCursorInternal(text: string): void;
};
const MARKER = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
const SGR = "(?:\\x1b\\[[0-9;]*m|\\x1b_pi:c\\x07)*";
const PASTE_SPAN = new RegExp(`${SGR}\\[${SGR}paste #(?:[^\\]]|${SGR})*\\]`, "g");
const PATH_TAG = /<path>([^<]+)<\/path>/g;
const CODES = /\x1b\[[0-9;]*m|\x1b_pi:c\x07/g;
const IMAGE_PATH =
	/(^|[^\w/@])((?:~|\/)[^\s,;'"(){}[\]]+\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif))(?=$|[\s,;'"(){}[\]])/gi;

/** Expand once: token-looking text inside a paste is literal user content. */
export function expandChips(text: string, registry: Registry): string {
	return text.replace(MARKER, (marker, id: string) => {
		const value = registry.get(Number(id));
		if (value === undefined) return marker;
		if (typeof value === "string") return `<paste>${value}</paste>`;
		return value.kind === "path" ? `<path>${value.path}</path>` : `<paste>${value.path}</paste>`;
	});
}

/** Re-emit the cursor (inverse video + TUI marker) that a chip swallowed. */
function keepCursor(span: string, label: string): string {
	const marker = span.includes(CURSOR_MARKER) ? CURSOR_MARKER : "";
	return span.includes("\x1b[7m")
		? `${marker}\x1b[7m${label.replaceAll(RST, `${RST}\x1b[7m`)}\x1b[27m`
		: marker + label;
}

/** Plain chip text: `head` is the identity, `meta` the dim size/id suffix. */
function chipLabel(
	value: string | Chip,
	id?: number,
): { head: string; meta: string; color: string } {
	if (typeof value === "string") {
		const lines = value.split("\n").length;
		const count =
			value.length < 1000 ? `${value.length}` : `${Number((value.length / 1000).toFixed(1))}k`;
		return {
			head: `${icon("paste.text")} text`,
			meta: lines > 10 ? `${lines} lines` : `${count} chars`,
			color: FG_GREEN,
		};
	}
	if (value.kind === "path") {
		const dir = value.path.endsWith("/");
		const name = basename(value.path) || value.path;
		// Same file-type glyphs the picker shows (trailing space is part of the icon).
		return {
			head: `${dir ? dirIcon() : fileIcon(value.path)}@${name}${dir && name !== "/" ? "/" : ""}`,
			meta: "",
			color: FG_BLUE,
		};
	}
	return {
		head: `${icon("paste.image")} image`,
		meta: id === undefined ? "" : `#${id}`,
		color: FG_BLUE,
	};
}

export function renderChips(line: string, registry: Registry): string {
	return line.replace(PASTE_SPAN, (span) => {
		const id = Number(/\[paste #(\d+)/.exec(span.replace(CODES, ""))?.[1]);
		const value = registry.get(id);
		if (value === undefined) return span;
		const { head, meta, color } = chipLabel(value, id);
		const label = `${color}${BOLD}${head}${RST}${meta ? `${FG_DIM} ${meta}${RST}` : ""}`;
		// Tight, no padding: Pi locates the cursor by its marker, so a shorter chip
		// just shifts following text left. render() clamps overflow.
		return keepCursor(span, label);
	});
}

const HISTORY_TAG = /<(paste|path)>([\s\S]*?)<\/\1>/g;
const IMAGE_FILE = /^(?:~|\/)\S+\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;
const PREVIEW_CHARS = 40;

/** Head…tail glimpse of a paste (whitespace collapsed, backticks dropped for inline code). */
function snippet(text: string): string {
	const flat = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
	if (flat.length <= PREVIEW_CHARS) return flat;
	const tail = Math.floor(PREVIEW_CHARS / 3);
	return `${flat.slice(0, PREVIEW_CHARS - tail).trimEnd()}…${flat.slice(-tail).trimStart()}`;
}

/**
 * Display-only: collapse `<paste>…</paste>` / `<path>…</path>` in a sent user
 * message into the same chips the editor showed. Session and model context
 * keep the full text; images take the paste chip since the file path is the
 * whole payload.
 */
export function renderHistoryChips(markdown: string): string {
	return markdown.replace(HISTORY_TAG, (_match, tag: string, body: string) => {
		let value: string | Chip = body;
		if (tag === "path") value = { kind: "path", path: body };
		else if (IMAGE_FILE.test(body)) value = { kind: "image", path: body };
		const { head, meta } = chipLabel(value);
		// Text pastes keep a short glimpse so history stays scannable.
		const preview = typeof value === "string" ? snippet(value) : "";
		return `\`${head}${meta ? ` ${meta}` : ""}${preview ? ` · ${preview}` : ""}\``;
	});
}

/** Patch one editor instance; order-independent with other instance patchers (pix-search). */
export function installChips(editor: CustomEditor): void {
	// SAFETY: Pi's TS-private members remain runtime properties on CustomEditor.
	const pi = editor as unknown as PiEditor;
	pi.expandPasteMarkers = (text) => expandChips(text, pi.pastes);
	const handlePaste = pi.handlePaste.bind(editor);
	pi.handlePaste = (text) => {
		const before = pi.pasteCounter;
		handlePaste(text);
		// Land the cursor after the chip, not glued to it.
		if (pi.pasteCounter > before) pi.insertTextAtCursorInternal(" ");
	};
	const insertTextAtCursor = editor.insertTextAtCursor.bind(editor);
	editor.insertTextAtCursor = (text: string) => {
		if (!text) return;
		// SAFETY: Pi snapshots and renumbers registry values without interpreting them.
		const chip = (kind: Chip["kind"], path: string) => {
			const id = ++pi.pasteCounter;
			pi.pastes.set(id, { kind, path });
			return `[paste #${id} ${path.length} chars]`;
		};
		const replaced = text
			.replace(PATH_TAG, (_match, path: string) => chip("path", path))
			.replace(IMAGE_PATH, (_match, prefix: string, path: string) => prefix + chip("image", path));
		insertTextAtCursor(/\[paste #\d+[^\]]*\]$/.test(replaced) ? `${replaced} ` : replaced);
	};
	const render = editor.render.bind(editor);
	editor.render = (width: number) =>
		render(width).map((line) => {
			// SAFETY: Pi owns the current registry, including its replacement during undo.
			const styled = renderChips(line, pi.pastes);
			// Restyling may widen a line (e.g. "#1" → "text"); clamp only on overflow.
			return visibleWidth(styled) > width ? truncateToWidth(styled, width, "") : styled;
		});
}

export default function (pi: ExtensionAPI): void {
	// Optional call: Pi < 0.85 has no Markdown transformer hook.
	pi.registerMarkdownTransformer?.((markdown, { messageType }) =>
		messageType === "user" ? renderHistoryChips(markdown) : markdown,
	);

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			const editor = previous?.(tui, theme, kb) ?? new CustomEditor(tui, theme, kb);
			// ponytail: chips need CustomEditor internals; a foreign editor is kept unchipped.
			if (editor instanceof CustomEditor) installChips(editor);
			return editor;
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setEditorComponent(undefined);
	});
}
