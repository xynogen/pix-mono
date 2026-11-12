/**
 * `$` skill picker — typing `$` at a token boundary opens a modal that lists
 * local skills (fuzzy by name) and, once the query has 2+ characters, skills.sh
 * search results. Picking inserts a `<skill>` token. On submit, `expandSkillTokens`
 * swaps the tokens for Pi's own `<skill name location>` block, so the transcript
 * shows the loaded skill as a collapsible card, the same as `/skill:name`.
 */

import { chipTag, SKILL_TAG } from "@xynogen/pix-pretty/chips";
import { frameLines, modalWidth } from "@xynogen/pix-pretty/modal-frame";
import { fadeLine } from "@xynogen/pix-pretty/text";
import { showTransientMessage } from "@xynogen/pix-pretty/transient-error";
import {
	CustomEditor,
	fuzzyFilter,
	matchesKey,
	mixColors,
	type TUI,
} from "@xynogen/pix-pretty/tui";
import type { ThemeLike } from "@xynogen/pix-pretty/types";
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";

const MAX_VISIBLE = 10;
const SEARCH_DELAY_MS = 300;

export interface SkillItem {
	name: string;
	/** skills.sh GitHub `owner/repo`; absent for a local skill. */
	source?: string;
	detail: string;
}

export type SearchSkills = (query: string, signal: AbortSignal) => Promise<SkillItem[]>;

/** Local: `<skill>name</skill>`. Remote: `<skill>owner/repo@name</skill>`. */
export function skillToken(item: SkillItem): string {
	return `${chipTag.skill(item.source ? `${item.source}@${item.name}` : item.name)} `;
}

export interface LoadedSkill {
	name: string;
	location: string;
	baseDir: string;
	body: string;
}

/**
 * Replace `<skill>` tokens with Pi-format skill blocks placed before the user text.
 * A token that fails to load stays in the text and is reported via `onError`.
 * Returns null when the text holds no token.
 */
export async function expandSkillTokens(
	text: string,
	load: (ref: string) => Promise<LoadedSkill>,
	onError: (ref: string, error: unknown) => void,
): Promise<string | null> {
	const refs = [...new Set([...text.matchAll(SKILL_TAG)].map((m) => m[1] ?? ""))];
	if (!refs.length) return null;
	const blocks: string[] = [];
	const loaded = new Set<string>();
	for (const ref of refs) {
		try {
			const skill = await load(ref);
			blocks.push(
				`<skill name="${skill.name}" location="${skill.location}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.body}\n</skill>`,
			);
			loaded.add(ref);
		} catch (error) {
			onError(ref, error);
		}
	}
	if (!blocks.length) return null;
	const rest = text
		.replace(SKILL_TAG, (token, ref: string) => (loaded.has(ref) ? "" : token))
		.replace(/[ \t]{2,}/g, " ")
		.trim();
	return rest ? `${blocks.join("\n\n")}\n\n${rest}` : blocks.join("\n\n");
}

export interface SkillPickerOptions {
	local: SkillItem[];
	theme: ThemeLike;
	search: SearchSkills;
	done: (item: SkillItem | null) => void;
	onChange: () => void;
	delayMs?: number;
}

export class SkillPicker {
	private query = "";
	private selected = 0;
	private remote: SkillItem[] = [];
	private status = "";
	private timer?: ReturnType<typeof setTimeout>;
	private controller?: AbortController;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private readonly opts: SkillPickerOptions) {}

	results(): SkillItem[] {
		// ponytail: name-only fuzzy. Descriptions match almost any query in order;
		// the skills.sh search covers intent-style queries.
		return [...fuzzyFilter(this.opts.local, this.query, (s) => s.name), ...this.remote];
	}

	private refresh(): void {
		this.invalidate();
		this.opts.onChange();
	}

	private schedule(): void {
		this.dispose();
		this.remote = [];
		const query = this.query.trim();
		this.status = query.length < 2 ? "" : "searching skills.sh…";
		if (!this.status) return;
		this.timer = setTimeout(() => {
			const controller = new AbortController();
			this.controller = controller;
			this.opts.search(query, controller.signal).then(
				(items) => {
					if (controller.signal.aborted) return;
					this.remote = items;
					this.status = items.length ? "" : "no skills.sh results";
					this.refresh();
				},
				(error: unknown) => {
					if (controller.signal.aborted) return;
					this.status = `skills.sh search failed: ${getErrorMessage(error)}`;
					this.refresh();
				},
			);
		}, this.opts.delayMs ?? SEARCH_DELAY_MS);
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.controller?.abort();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.opts.done(null);
		else if (matchesKey(data, "enter")) this.opts.done(this.results()[this.selected] ?? null);
		else if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down"))
			this.selected = Math.min(this.results().length - 1, this.selected + 1);
		else if (matchesKey(data, "backspace")) {
			this.query = this.query.slice(0, -1);
			this.selected = 0;
			this.schedule();
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.selected = 0;
			this.schedule();
		} else return;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const theme = this.opts.theme;
		const inner = modalWidth(width) - 4;
		const results = this.results();
		if (this.selected >= results.length) this.selected = Math.max(0, results.length - 1);
		const start = Math.max(
			0,
			Math.min(this.selected - MAX_VISIBLE + 1, results.length - MAX_VISIBLE),
		);

		const count = theme.fg(
			"muted",
			`${results.length} ${results.length === 1 ? "match" : "matches"}`,
		);
		const rows = [
			`${theme.bold(theme.fg("accent", "  Find skills"))}  ${count}`,
			"",
			`${theme.fg("accent", "❯")} ${
				this.query ? theme.fg("text", this.query) : theme.fg("muted", "type to filter…")
			}`,
			"",
		];
		// Overflow fades into the modal background instead of ending in "…".
		const { colors, style } = theme as Partial<{
			colors: Record<string, Parameters<typeof mixColors>[0]>;
			style: (text: string, options: { fg: ReturnType<typeof mixColors> }) => string;
		}>;
		const muted = colors?.muted;
		const base = colors?.customMessageBg;
		// Ease in over a wide ramp and stop short of the background: a quiet fade, not a cutoff.
		const fade = (text: string, amount: number) =>
			muted && base && style
				? style.call(theme, text, { fg: mixColors(muted, base, amount ** 1.6 * 0.8) })
				: theme.fg(amount < 0.5 ? "dim" : "muted", text);
		if (!results.length) rows.push(theme.fg("muted", "  no matching skills"));
		for (const [i, item] of results.slice(start, start + MAX_VISIBLE).entries()) {
			const isSel = start + i === this.selected;
			const marker = isSel ? theme.fg("accent", "›") : " ";
			const name = theme.fg(isSel ? "accent" : "dim", item.name);
			const tag = theme.fg("muted", item.source ? "skills.sh" : "local");
			rows.push(
				fadeLine(`${marker} ${name} ${tag} ${theme.fg("muted", item.detail)}`, inner, fade, 12),
			);
		}
		if (this.status) rows.push("", theme.fg("muted", `  ${this.status}`));
		rows.push("", theme.fg("muted", "↑↓ move · ⏎ insert · esc cancel"));

		this.cachedLines = frameLines({
			width: modalWidth(width),
			lines: rows,
			wrap: false,
			color: (s) => theme.fg("accent", s),
			fg: (s) => theme.fg("text", s),
			bg: theme.bg ? (s) => theme.bg?.("customMessageBg", s) ?? s : undefined,
		});
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/**
 * Open the picker on a boundary `$` (line start or after whitespace).
 * ponytail: mirrors pix-search's `@` trigger. Move both to a pix-pretty
 * `editor-trigger` subpath if a third trigger appears (needs a minor bump).
 */
export function attachSkillPicker(
	editor: CustomEditor,
	tui: TUI,
	open: () => Promise<SkillItem | null>,
	onError: (message: string) => void,
): void {
	const handleInput = editor.handleInput.bind(editor);
	let inPaste = false;
	const run = async () => {
		try {
			const item = await open();
			editor.insertTextAtCursor(item ? skillToken(item) : "$");
		} catch (error) {
			editor.insertTextAtCursor("$");
			onError(`Skill picker failed: ${getErrorMessage(error)}`);
		} finally {
			tui.requestRender();
		}
	};
	editor.handleInput = (data: string) => {
		// A pasted `$` (bracketed paste, maybe split across chunks) is not a shortcut.
		for (const marker of data.matchAll(/\x1b\[(200|201)~/g)) inPaste = marker[1] === "200";
		if (!inPaste && data === "$") {
			const cursor = editor.getCursor();
			const before = (editor.getLines()[cursor.line] ?? "").slice(0, cursor.col);
			if (before === "" || /\s$/.test(before)) {
				void run();
				return;
			}
		}
		handleInput(data);
	};
}

export function registerSkillPicker(
	pi: ExtensionAPI,
	listLocal: () => SkillItem[],
	search: SearchSkills,
): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const open = () =>
			ctx.ui.custom<SkillItem | null>(
				(tui, theme, _kb, done) => {
					const picker = new SkillPicker({
						local: listLocal(),
						theme,
						search,
						done,
						onChange: () => tui.requestRender(),
					});
					return {
						render: (width: number) => picker.render(width),
						handleInput: (data: string) => picker.handleInput(data),
						invalidate: () => picker.invalidate(),
						dispose: () => picker.dispose(),
					};
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "60%", maxHeight: "60%" } },
			);

		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			const editor = previous?.(tui, theme, kb) ?? new CustomEditor(tui, theme, kb);
			if (editor instanceof CustomEditor) {
				attachSkillPicker(editor, tui, open, (message) =>
					showTransientMessage(ctx.ui, message, "error"),
				);
			} else {
				showTransientMessage(
					ctx.ui,
					"pix-skills: $ picker requires a CustomEditor; existing editor kept.",
					"warning",
				);
			}
			return editor;
		});
	});
}
