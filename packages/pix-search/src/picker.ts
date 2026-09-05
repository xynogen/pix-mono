/**
 * File picker overlay — a self-contained modal with its own query input and
 * result list. Unlike the inline `@` dropdown, this owns keyboard focus, so
 * spaces in the query are native (no quoting hack) and the host editor's
 * space-stops-autocomplete behavior is irrelevant.
 *
 * The component is a plain pi-tui `Component` (render + handleInput). It is
 * pure w.r.t. file discovery: it receives the already-listed files and a
 * recency map, ranks them with `rankFiles`, and reports the chosen path (or
 * null on cancel) through the `done` callback.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { hlBlock } from "@xynogen/pix-pretty/highlight";
import { dirIcon, fileColor, fileIcon } from "@xynogen/pix-pretty/icons";
import { lang } from "@xynogen/pix-pretty/lang";
import { frameLines, joinColumns, modalWidth } from "@xynogen/pix-pretty/modal-frame";
import type { ThemeLike } from "@xynogen/pix-pretty/types";
import { rankFiles } from "./rank.ts";
import type { RecencyMap } from "./recency.ts";

const MAX_VISIBLE = 10;
/** Show the preview pane only when the modal is at least this wide. */
const PREVIEW_MIN_WIDTH = 72;
/** How many lines of the selected file to preview. */
const PREVIEW_LINES = 14;
/** Cap the bytes we read for a preview — enough for PREVIEW_LINES of code. */
const PREVIEW_MAX_BYTES = 8 * 1024;

export interface FilePickerOptions {
	files: string[];
	recency: RecencyMap;
	theme: ThemeLike;
	/** Root for resolving relative result paths when reading previews. */
	cwd: string;
	/** Called with the chosen path, or null on cancel. */
	done: (path: string | null) => void;
	/** Ask the host to re-render (e.g. after an async syntax-highlight lands). */
	onChange?: () => void;
	/** Seed query (e.g. characters typed after @ before the picker opened). */
	initialQuery?: string;
}

export class FilePicker {
	private query: string;
	private selected = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	private files: string[];
	/** Syntax-highlighted preview lines, keyed by file path. Filled async by
	 *  hlBlock; a miss shows plain text until the highlight lands. */
	private hlCache = new Map<string, string[]>();

	constructor(private readonly opts: FilePickerOptions) {
		this.query = opts.initialQuery ?? "";
		this.files = opts.files;
	}

	/** Replace the candidate file list (e.g. once async `rg --files` returns). */
	setFiles(files: string[]): void {
		this.files = files;
		this.invalidate();
	}

	private results() {
		return rankFiles(this.files, this.query, this.opts.recency, 50);
	}

	/** Color a result label: dirs use accent/dim, files use their type hue when
	 *  selected and dim otherwise (so the selection pops without noise). */
	private styleName(path: string, label: string, isDir: boolean, isSel: boolean): string {
		const theme = this.opts.theme;
		if (isDir) return theme.fg(isSel ? "accent" : "dim", label);
		return isSel ? fileColor(path, label, theme) : theme.fg("dim", label);
	}

	/** Preview lines for the selected result: a folder shows its immediate
	 *  file/dir list (icon-prefixed); a file shows its first lines, syntax-
	 *  highlighted once hlBlock resolves. Returns [] on any error (unreadable,
	 *  binary, missing) so the pane just stays empty. */
	private preview(path: string): string[] {
		const theme = this.opts.theme;
		if (path.endsWith("/")) {
			const children = new Set<string>();
			for (const f of this.files) {
				if (!f.startsWith(path)) continue;
				const rest = f.slice(path.length).split("/");
				children.add(rest.length > 1 ? `${rest[0]}/` : (rest[0] ?? ""));
			}
			return [...children]
				.filter(Boolean)
				.sort((a, b) => a.localeCompare(b))
				.slice(0, PREVIEW_LINES)
				.map((child) => {
					const isDir = child.endsWith("/");
					const icon = isDir ? dirIcon(theme) : fileIcon(child, theme);
					const name = isDir ? theme.fg("accent", child) : fileColor(child, child, theme);
					return `${icon}${name}`;
				});
		}
		const cached = this.hlCache.get(path);
		if (cached) return cached;
		try {
			const abs = isAbsolute(path) ? path : join(this.opts.cwd, path);
			const buf = readFileSync(abs).subarray(0, PREVIEW_MAX_BYTES).toString("utf8");
			if (buf.includes("\u0000")) return []; // binary
			const plain = buf.split("\n").slice(0, PREVIEW_LINES);
			// Kick off async highlight; cache + re-render when it lands.
			void hlBlock(plain.join("\n"), lang(path), theme).then((hl) => {
				this.hlCache.set(path, hl);
				this.invalidate();
				this.opts.onChange?.();
			});
			return plain; // plain until the highlight resolves
		} catch {
			return [];
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.opts.done(null);
			return;
		}
		if (matchesKey(data, "enter")) {
			const hit = this.results()[this.selected];
			this.opts.done(hit ? hit.path : null);
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(this.results().length - 1, this.selected + 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.query = this.query.slice(0, -1);
			this.selected = 0;
			this.invalidate();
			return;
		}
		// Printable characters (including space) extend the query.
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.selected = 0;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const theme = this.opts.theme;
		const inner = modalWidth(width) - 4; // frame chrome
		const results = this.results();
		if (this.selected >= results.length) this.selected = Math.max(0, results.length - 1);

		// Scroll window around the selection.
		const start = Math.max(
			0,
			Math.min(this.selected - MAX_VISIBLE + 1, results.length - MAX_VISIBLE),
		);
		const visible = results.slice(start, start + MAX_VISIBLE);

		// Header: bold title + live result count, then the query line.
		const count = theme.fg(
			"muted",
			`${results.length} ${results.length === 1 ? "match" : "matches"}`,
		);
		const title = `${theme.bold(theme.fg("accent", "  Find files & folders"))}  ${count}`;
		const queryLine = `${theme.fg("accent", "❯")} ${
			this.query ? theme.fg("text", this.query) : theme.fg("muted", "type to filter…")
		}`;

		// Two-pane layout when the modal is wide: results on the left, a preview
		// of the selected entry on the right. Narrow terminals fall back to a
		// single result column.
		const showPreview = inner >= PREVIEW_MIN_WIDTH && results.length > 0;
		const listW = showPreview ? Math.floor(inner * 0.45) : inner;
		const gap = 2;
		const previewW = inner - listW - gap;

		const listRows: string[] = [];
		if (results.length === 0) {
			listRows.push(theme.fg("muted", "  no matching files"));
		} else {
			for (const [i, entry] of visible.entries()) {
				const isSel = start + i === this.selected;
				const isDir = entry.path.endsWith("/");
				const marker = isSel ? theme.fg("accent", "›") : " ";
				const icon = isDir ? dirIcon(theme) : fileIcon(entry.path, theme);
				const name = this.styleName(entry.path, entry.label, isDir, isSel);
				const dir = entry.path.slice(0, entry.path.length - entry.label.length);
				const dirText = dir ? theme.fg("muted", dir) : "";
				listRows.push(truncateToWidth(`${marker} ${icon}${name} ${dirText}`, listW));
			}
		}

		const rows: string[] = [title, "", queryLine, ""];
		if (showPreview) {
			const sel = results[this.selected];
			const previewRows = sel ? this.preview(sel.path) : [];
			const head = sel
				? theme.fg(
						"muted",
						truncateToWidth(sel.path.endsWith("/") ? `${sel.path} · contents` : sel.path, previewW),
					)
				: "";
			const previewLines = [
				head,
				theme.fg("border", "─".repeat(previewW)),
				...previewRows.map((l) => truncateToWidth(l, previewW)),
			];
			rows.push(
				...joinColumns(listRows, previewLines, { leftWidth: listW, rightWidth: previewW, gap }),
			);
		} else {
			rows.push(...listRows);
		}

		const hint = theme.fg("muted", "↑↓ move · ⏎ insert · esc cancel");
		rows.push("", hint);

		this.cachedLines = frameLines({
			width: modalWidth(width),
			lines: rows,
			color: (s) => theme.fg("accent", s),
			fg: (s) => theme.fg("text", s),
		});
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
