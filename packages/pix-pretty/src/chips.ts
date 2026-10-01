/**
 * chips — the one source of truth for inline chip tags: their text format
 * (`chipTag`), editor chips, and sent-message chips. Producers (pix-search `@`,
 * pix-skills `$`, pix-core `/plan`) build tags with `chipTag`. pix-display
 * activates the renderer with `registerChips(pi)`.
 *
 *   long pasted text        →  buffer: [paste #1 +42 lines]     display: 󰉿 text 42 lines
 *   /tmp/shot.png           →  buffer: [paste #2 13 chars]      display: 󰋩 image #2
 *   <path>src/a.ts</path>   →  buffer: [paste #3 8 chars]       display: 󰉿 @a.ts
 *   <prompt name="plan">…   →  buffer: [paste #4 900 chars]     display:  prompt
 *   <prompt name="plan-edit">…  →  …                            display:  edit prompt
 *   <skill>a/b@tdd</skill>  →  buffer: [paste #5 7 chars]       display: 󱁤 $tdd a/b
 *
 * Tags and Pi's `<paste>…</paste>` payloads are promoted to atomic paste markers (one backspace deletes the whole chip) and
 * expanded back verbatim for the model.
 */
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BOLD, FG_BLUE, FG_DIM, FG_GREEN, FG_YELLOW, RST } from "./ansi.ts";
import { icon } from "./icon-catalog.ts";
import { dirIcon, fileIcon } from "./icons.ts";

/** Build a chip tag. The model receives the tag verbatim. The UI shows a chip. */
export const chipTag = {
	/** `@` file or folder mention. A folder keeps its trailing `/`. */
	path: (path: string) => `<path>${path}</path>`,
	/** `$` skill: `name` (local) or `owner/repo@name` (skills.sh). */
	skill: (ref: string) => `<skill>${ref}</skill>`,
	/** Injected prompt, e.g. `/plan`. `name` must match `[\w-]+`. */
	prompt: (name: string, body: string) => `<prompt name="${name}">${body}</prompt>`,
};

// ponytail: Pi only exposes atomic paste tokens today. Keep its private registry
// adapter here; replace this adapter when Pi provides a public inline-token API.
type Chip =
	| { kind: "image" | "path"; path: string }
	| { kind: "skill"; ref: string }
	| { kind: "prompt"; name: string; body: string };
type Registry = Map<number, string | Chip>;
type PiEditor = {
	pastes: Registry;
	pasteCounter: number;
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	setCursorCol(col: number): void;
	expandPasteMarkers(text: string): string;
	handlePaste(text: string): void;
	insertTextAtCursorInternal(text: string): void;
};
/** A text paste becomes a chip only above this many characters (Pi's own limit is 1000). */
const PASTE_MAX_CHARS = 100;
const MARKER = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
const SGR = "(?:\\x1b\\[[0-9;]*m|\\x1b_pi:c\\x07)*";
const PASTE_SPAN = new RegExp(`${SGR}\\[${SGR}paste #(?:[^\\]]|${SGR})*\\]`, "g");
const PATH_TAG = /<path>([^<]+)<\/path>/g;
/** Matches `chipTag.skill` output. Group 1 is the ref. */
export const SKILL_TAG = /<skill>([^<]+)<\/skill>/g;
const PASTE_TAG = /<paste>([\s\S]*?)<\/paste>/g;
// Injected prompt from another extension (e.g. /plan). Kept as a tag for the model.
const PROMPT_TAG = /<prompt name="([\w-]+)">([\s\S]*?)<\/prompt>/g;
const PROMPT_ONLY = /^<prompt name="[\w-]+">[\s\S]*<\/prompt>\s*$/;
const CODES = /\x1b\[[0-9;]*m|\x1b_pi:c\x07/g;
const IMAGE_PATH =
	/(^|[^\w/@])((?:~|[a-zA-Z]:[/\\]|\/|\\\\)[^\s,;'"(){}[\]]+\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif))(?=$|[\s,;'"(){}[\]])/gi;

/** Expand once: token-looking text inside a paste is literal user content. */
export function expandChips(text: string, registry: Registry): string {
	return text.replace(MARKER, (marker, id: string) => {
		const value = registry.get(Number(id));
		if (value === undefined) return marker;
		if (typeof value === "string") return `<paste>${value}</paste>`;
		if (value.kind === "prompt") return chipTag.prompt(value.name, value.body);
		if (value.kind === "skill") return chipTag.skill(value.ref);
		return value.kind === "path" ? chipTag.path(value.path) : `<paste>${value.path}</paste>`;
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
		const count =
			value.length < 1000 ? `${value.length}` : `${Number((value.length / 1000).toFixed(1))}k`;
		return {
			head: `${icon("paste.text")} text`,
			meta: `${count} chars`,
			color: FG_GREEN,
		};
	}
	if (value.kind === "prompt") {
		// The first name segment is the producer namespace (`plan`). The icon already shows it.
		const sub = value.name.split("-").slice(1).join("-");
		return {
			head: `${icon("paste.prompt")}${sub ? ` ${sub}` : ""}`,
			meta: "prompt",
			color: FG_YELLOW,
		};
	}
	if (value.kind === "skill") {
		// `owner/repo@name` (skills.sh) or bare `name` (local).
		const at = value.ref.lastIndexOf("@");
		// ponytail: reuses the `tools` icon. Add a `skill` catalog key in pix-runtime if it needs its own glyph.
		return {
			head: `${icon("tools")} $${value.ref.slice(at + 1)}`,
			meta: at < 0 ? "" : value.ref.slice(0, at),
			color: FG_YELLOW,
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

const HISTORY_TAG =
	/<(paste|path|skill)>([\s\S]*?)<\/\1>|<prompt name="([\w-]+)">([\s\S]*?)<\/prompt>/g;
const IMAGE_FILE =
	/^(?:~|[a-zA-Z]:[/\\]|\/|\\\\)[^\r\n]+\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;
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
	return markdown.replace(
		HISTORY_TAG,
		(_match, tag?: string, text?: string, name?: string, prompt?: string) => {
			if (name !== undefined) {
				const { head, meta } = chipLabel({ kind: "prompt", name, body: prompt ?? "" });
				return `\`${head} ${meta}\``;
			}
			const body = text ?? "";
			let value: string | Chip = body;
			if (tag === "path") value = { kind: "path", path: body };
			else if (tag === "skill") value = { kind: "skill", ref: body };
			else if (IMAGE_FILE.test(body)) value = { kind: "image", path: body };
			const { head, meta } = chipLabel(value);
			// Text pastes keep a short glimpse so history stays scannable.
			const preview = typeof value === "string" ? snippet(value) : "";
			return `\`${head}${meta ? ` ${meta}` : ""}${preview ? ` · ${preview}` : ""}\``;
		},
	);
}

/** Patch one editor instance; order-independent with other instance patchers (pix-search). */
export function installChips(editor: CustomEditor): void {
	// SAFETY: Pi's TS-private members remain runtime properties on CustomEditor.
	const pi = editor as unknown as PiEditor;
	pi.expandPasteMarkers = (text) => expandChips(text, pi.pastes);
	const handlePaste = pi.handlePaste.bind(editor);
	pi.handlePaste = (text) => {
		if (IMAGE_FILE.test(text) || PROMPT_ONLY.test(text)) {
			editor.insertTextAtCursor(IMAGE_FILE.test(text) ? `<paste>${text}</paste>` : text.trim());
			return;
		}
		// Pi cleans the text, takes the undo snapshot and picks inline vs chip by its own
		// rule (>10 lines or >1000 chars). Size alone decides here, so fix Pi's pick after it.
		const { cursorLine: l0, cursorCol: c0 } = pi.state;
		const before = pi.pasteCounter;
		handlePaste(text);
		const chipped = pi.pasteCounter > before ? pi.pastes.get(pi.pasteCounter) : undefined;
		if (chipped !== undefined && typeof chipped !== "string") return;
		// Pi inserted its text or marker from (l0, c0) to the cursor.
		const { lines, cursorLine: l1, cursorCol: c1 } = pi.state;
		const first = lines[l0] ?? "";
		const last = lines[l1] ?? "";
		const value =
			chipped ??
			(l0 === l1
				? first.slice(c0, c1)
				: [first.slice(c0), ...lines.slice(l0 + 1, l1), last.slice(0, c1)].join("\n"));
		const wantChip = value.length > PASTE_MAX_CHARS;
		if (wantChip !== (chipped !== undefined)) {
			pi.state.lines = [
				...lines.slice(0, l0),
				first.slice(0, c0) + last.slice(c1),
				...lines.slice(l1 + 1),
			];
			pi.state.cursorLine = l0;
			pi.setCursorCol(c0);
			if (wantChip) {
				const id = ++pi.pasteCounter;
				pi.pastes.set(id, value);
				pi.insertTextAtCursorInternal(`[paste #${id} ${value.length} chars]`);
			} else {
				pi.pastes.delete(pi.pasteCounter);
				pi.pasteCounter = before;
				pi.insertTextAtCursorInternal(value);
			}
		}
		// Land the cursor after the chip, not glued to it.
		if (wantChip) pi.insertTextAtCursorInternal(" ");
	};
	const insertTextAtCursor = editor.insertTextAtCursor.bind(editor);
	editor.insertTextAtCursor = (text: string) => {
		if (!text) return;
		// SAFETY: Pi snapshots and renumbers registry values without interpreting them.
		const chip = (value: string | Chip, length: number) => {
			const id = ++pi.pasteCounter;
			pi.pastes.set(id, value);
			return `[paste #${id} ${length} chars]`;
		};
		if (IMAGE_FILE.test(text.trim())) {
			const trimmed = text.trim();
			const replaced = chip({ kind: "image", path: trimmed }, trimmed.length);
			insertTextAtCursor(`${replaced} `);
			return;
		}
		const replaced = text
			.replace(PROMPT_TAG, (_match, name: string, body: string) =>
				chip({ kind: "prompt", name, body }, body.length),
			)
			.replace(PATH_TAG, (_match, path: string) => chip({ kind: "path", path }, path.length))
			.replace(SKILL_TAG, (_match, ref: string) => chip({ kind: "skill", ref }, ref.length))
			.replace(PASTE_TAG, (_match, body: string) =>
				chip(IMAGE_FILE.test(body) ? { kind: "image", path: body } : body, body.length),
			)
			.replace(
				IMAGE_PATH,
				(_match, prefix: string, path: string) =>
					prefix + chip({ kind: "image", path }, path.length),
			);
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

/** Activate chips: sent-message transformer + editor patch. pix-display calls this. */
export function registerChips(pi: ExtensionAPI): void {
	// ponytail: local Pi 0.82 types predate the runtime Markdown transformer hook.
	const markdownPi = pi as ExtensionAPI & {
		registerMarkdownTransformer?: (
			transformer: (markdown: string, context: { messageType: string }) => string,
		) => void;
	};
	markdownPi.registerMarkdownTransformer?.((markdown, { messageType }) =>
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
