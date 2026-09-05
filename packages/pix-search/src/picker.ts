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

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { frameLines, modalWidth } from "@xynogen/pix-pretty/modal-frame";
import type { ThemeLike } from "@xynogen/pix-pretty/types";
import { rankFiles } from "./rank.ts";
import type { RecencyMap } from "./recency.ts";

const MAX_VISIBLE = 10;

export interface FilePickerOptions {
	files: string[];
	recency: RecencyMap;
	theme: ThemeLike;
	/** Called with the chosen path, or null on cancel. */
	done: (path: string | null) => void;
	/** Seed query (e.g. characters typed after @ before the picker opened). */
	initialQuery?: string;
}

export class FilePicker {
	private query: string;
	private selected = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	private files: string[];

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

		const queryLine = `${theme.fg("accent", "@")} ${
			this.query ? theme.fg("text", this.query) : theme.fg("muted", "type to filter files…")
		}`;

		const rows: string[] = [queryLine, ""];
		if (results.length === 0) {
			rows.push(theme.fg("muted", "  no matching files"));
		} else {
			for (const [i, entry] of visible.entries()) {
				const isSel = start + i === this.selected;
				const marker = isSel ? theme.fg("accent", "›") : " ";
				const name = isSel ? theme.fg("text", entry.label) : theme.fg("dim", entry.label);
				const dir = entry.path.slice(0, entry.path.length - entry.label.length);
				const dirText = dir ? theme.fg("muted", dir) : "";
				rows.push(truncateToWidth(`${marker} ${name} ${dirText}`, inner));
			}
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
