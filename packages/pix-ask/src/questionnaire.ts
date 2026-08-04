import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	decodeKittyPrintable,
	fuzzyFilter,
	Key,
	type KeybindingsManager,
	Markdown,
	matchesKey,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	frameModal,
	MIN_MODAL_HEIGHT,
	ModalPager,
	modalWidth,
	terminalModalHeight,
} from "@xynogen/pix-pretty/modal-frame";
import { ChipEditor } from "./chip-editor.js";
import { dim } from "./components.js";
import { checkboxGlyphs, selectionGlyph } from "./glyphs.js";
import { safeMarkdownTheme, sentinelsFor } from "./helpers.js";
import type { OptionData, Params, QuestionData } from "./schema.js";
import { SENTINEL_FREEFORM, SENTINEL_NEXT, SEPARATOR, SPLIT_PANE_MIN_WIDTH } from "./schema.js";
import type { AnswerKind, QuestionAnswer, QuestionnaireResult } from "./types.js";

// ── AskQuestionnaire ───────────────────────────────────────────────────

function printableCharacter(data: string): string | undefined {
	const decoded = decodeKittyPrintable(data) ?? data;
	const characters = [...decoded];
	if (characters.length !== 1) return undefined;
	const codePoint = characters[0]?.codePointAt(0);
	if (
		codePoint === undefined ||
		codePoint < 32 ||
		codePoint === 127 ||
		(codePoint >= 128 && codePoint <= 159)
	) {
		return undefined;
	}
	return characters[0];
}

export class AskQuestionnaire extends Container {
	private params: Params;
	private tui: TUI;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private onDone: (result: QuestionnaireResult | null) => void;

	private currentIndex = 0;
	private answers: QuestionAnswer[] = [];
	private searchQuery = "";
	private selectedOptionIndex = 0;
	private multiChecked = new Set<number>();
	private inputMode = false;
	private editor?: ChipEditor;
	private mdTheme = safeMarkdownTheme();
	private pager = new ModalPager();
	private selectedOptionRows: { start: number; end: number } | undefined;

	constructor(
		params: Params,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		onDone: (result: QuestionnaireResult | null) => void,
	) {
		super();
		this.params = params;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.onDone = onDone;
	}

	// ── Accessors ──────────────────────────────────────────────────────

	private get currentQ(): QuestionData {
		const q = this.params.questions[this.currentIndex];
		if (!q) throw new Error("currentIndex out of bounds");
		return q;
	}

	private get filteredOptions(): OptionData[] {
		if (!this.searchQuery) return this.currentQ.options;
		return fuzzyFilter(
			this.currentQ.options,
			this.searchQuery,
			(o) => `${o.label} ${o.description}`,
		);
	}

	private get mainListItems(): Array<{
		kind: string;
		label?: string;
		option?: OptionData;
	}> {
		const items: Array<{ kind: string; label?: string; option?: OptionData }> = [];
		for (const o of this.filteredOptions) {
			items.push({ kind: "option", option: o });
		}
		for (const s of sentinelsFor(this.currentQ)) {
			items.push({ kind: s.kind, label: s.label });
		}
		return items;
	}

	private get totalItems(): number {
		return this.mainListItems.length;
	}

	private get selectedItem(): (typeof this.mainListItems)[0] | undefined {
		return this.mainListItems[this.selectedOptionIndex];
	}

	// ── Layout ─────────────────────────────────────────────────────────

	private ensureEditor(): ChipEditor {
		if (this.editor) return this.editor;
		const editor = new ChipEditor(this.tui, {
			borderColor: (s: string) => this.theme.fg("accent", s),
			selectList: {
				selectedPrefix: (s: string) => this.theme.fg("accent", s),
				selectedText: (s: string) => this.theme.fg("accent", s),
				description: (s: string) => this.theme.fg("muted", s),
				scrollInfo: (s: string) => this.theme.fg("dim", s),
				noMatch: (s: string) => this.theme.fg("warning", s),
			},
		});
		editor.disableSubmit = false;
		editor.onSubmit = (text: string) => this.handleFreeformSubmit(text);
		editor.focused = true;
		this.editor = editor;
		return editor;
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	// ── Answer management ──────────────────────────────────────────────

	private recordAnswer(
		kind: AnswerKind,
		answer: string | null,
		selected?: string[],
		preview?: string,
	): void {
		this.answers = this.answers.filter((a) => a.questionIndex !== this.currentIndex);
		this.answers.push({
			questionIndex: this.currentIndex,
			question: this.currentQ.question,
			kind,
			answer,
			selected,
			preview,
		});
	}

	private commitAnswer(): void {
		const item = this.selectedItem;
		if (!item) {
			this.cancel();
			return;
		}

		if (item.kind === "option" && item.option) {
			this.recordAnswer("option", item.option.label, undefined, item.option.preview);
			this.nextQuestion();
		} else if (item.kind === "other") {
			this.inputMode = true;
			this.ensureEditor().focused = true;
			this.refresh();
		} else if (item.kind === "next") {
			const selected = Array.from(this.multiChecked)
				.sort((a, b) => a - b)
				.map((i) => this.currentQ.options[i]?.label ?? "");
			if (selected.length === 0) {
				this.cancel();
				return;
			}
			this.recordAnswer("multi", null, selected);
			this.nextQuestion();
		}
	}

	private handleFreeformSubmit(text: string): void {
		if (!text.trim()) {
			this.cancel();
			return;
		}
		this.recordAnswer("custom", text.trim());
		this.nextQuestion();
	}

	private gotoQuestion(index: number): void {
		if (index < 0 || index >= this.params.questions.length) return;
		this.currentIndex = index;
		this.searchQuery = "";
		this.multiChecked.clear();
		this.inputMode = false;
		this.selectedOptionIndex = 0;
		this.editor = undefined;
		this.pager.reset();
		this.restoreAnswerState();
		this.refresh();
	}

	private restoreAnswerState(): void {
		const prev = this.answers.find((a) => a.questionIndex === this.currentIndex);
		if (!prev) return;
		const q = this.currentQ;
		if (prev.kind === "multi") {
			for (let i = 0; i < q.options.length; i++) {
				if (prev.selected?.includes(q.options[i]?.label ?? "")) {
					this.multiChecked.add(i);
				}
			}
		} else if (prev.kind === "option" && prev.answer) {
			const idx = this.mainListItems.findIndex(
				(it) => it.kind === "option" && it.option?.label === prev.answer,
			);
			if (idx >= 0) this.selectedOptionIndex = idx;
		} else if (prev.kind === "custom") {
			const idx = this.mainListItems.findIndex((it) => it.kind === "other");
			if (idx >= 0) this.selectedOptionIndex = idx;
		}
	}

	private nextQuestion(): void {
		const total = this.params.questions.length;
		const answered = new Set(this.answers.map((a) => a.questionIndex));
		for (let step = 1; step <= total; step++) {
			const idx = (this.currentIndex + step) % total;
			if (!answered.has(idx)) {
				this.gotoQuestion(idx);
				return;
			}
		}
		this.answers.sort((a, b) => a.questionIndex - b.questionIndex);
		this.onDone({ answers: this.answers, cancelled: false });
	}

	private cancel(): void {
		this.onDone({ answers: this.answers, cancelled: true });
	}

	private toggleMulti(index: number): void {
		if (index < 0 || index >= this.currentQ.options.length) return;
		if (this.multiChecked.has(index)) this.multiChecked.delete(index);
		else this.multiChecked.add(index);
		this.invalidate();
	}

	// ── Input handling ─────────────────────────────────────────────────

	handleInput(data: string): void {
		// Input mode owns esc (back to options) — handle it BEFORE the global
		// cancel guard, which is also bound to esc and would otherwise close the
		// whole questionnaire instead of stepping back.
		if (this.inputMode) {
			if (this.pager.handleInput(data, this.keybindings)) {
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.inputMode = false;
				this.editor = undefined;
				this.refresh();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.cancel();
				return;
			}
			this.ensureEditor().handleInput(data);
			this.tui.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		if (this.pager.handleInput(data, this.keybindings)) {
			this.refresh();
			return;
		}

		const isMulti = !!this.currentQ.multiSelect;
		const total = this.totalItems;

		if (
			this.keybindings.matches(data, "tui.select.up") ||
			matchesKey(data, Key.shift("tab")) ||
			matchesKey(data, Key.ctrl("k"))
		) {
			if (total > 0) {
				this.selectedOptionIndex = (this.selectedOptionIndex - 1 + total) % total;
				this.pager.followSelection();
				this.refresh();
			}
			return;
		}

		if (
			this.keybindings.matches(data, "tui.select.down") ||
			matchesKey(data, Key.tab) ||
			matchesKey(data, Key.ctrl("j"))
		) {
			if (total > 0) {
				this.selectedOptionIndex = (this.selectedOptionIndex + 1) % total;
				this.pager.followSelection();
				this.refresh();
			}
			return;
		}

		if (matchesKey(data, Key.left)) {
			this.gotoQuestion(this.currentIndex - 1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.gotoQuestion(this.currentIndex + 1);
			return;
		}

		if (
			this.keybindings.matches(data, "tui.editor.deleteCharBackward") ||
			matchesKey(data, Key.backspace)
		) {
			if (this.searchQuery) {
				const chars = [...this.searchQuery];
				chars.pop();
				this.searchQuery = chars.join("");
				this.selectedOptionIndex = 0;
				this.pager.followSelection();
				this.refresh();
			}
			return;
		}

		if (matchesKey(data, Key.escape)) {
			if (this.searchQuery) {
				this.searchQuery = "";
				this.selectedOptionIndex = 0;
				this.pager.followSelection();
				this.refresh();
			}
			return;
		}

		if (matchesKey(data, Key.space) && isMulti) {
			if (this.selectedItem?.kind === "option" && this.selectedItem.option) {
				const idx = this.filteredOptions.indexOf(this.selectedItem.option);
				if (idx >= 0) this.toggleMulti(idx);
				this.refresh();
			}
			return;
		}

		// Decode CSI-u first: under Kitty flag 1 digits arrive as escape
		// sequences, and the raw regex would miss them (digit would fall
		// through into the search query instead of selecting an option).
		const numMatch = (decodeKittyPrintable(data) ?? data).match(/^[1-9]$/);
		if (numMatch && this.filteredOptions.length > 0) {
			const idx = Number(numMatch[0]) - 1;
			if (idx >= 0 && idx < this.filteredOptions.length) {
				if (isMulti) {
					this.toggleMulti(idx);
					this.selectedOptionIndex = Math.min(idx, this.totalItems - 1);
					this.refresh();
				} else {
					const opt = this.filteredOptions[idx];
					if (!opt) return;
					this.recordAnswer("option", opt.label, undefined, opt.preview);
					this.nextQuestion();
				}
				return;
			}
		}

		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.commitAnswer();
			return;
		}

		if (!isMulti) {
			// Accept Unicode text under both legacy and Kitty encodings, while
			// rejecting C0, DEL, and C1 controls that corrupt filter queries.
			const printable = printableCharacter(data);
			if (printable !== undefined) {
				this.searchQuery += printable;
				this.selectedOptionIndex = 0;
				this.pager.followSelection();
				this.refresh();
			}
		}
	}

	// ── Rendering ──────────────────────────────────────────────────────

	private renderOptions(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(20, width - 6);
		const isMulti = !!this.currentQ.multiSelect;
		const items = this.mainListItems;
		const total = items.length;
		const box = checkboxGlyphs();
		// Glyph per option: checkbox (▣/☐) for multi, radio (◉/○) for single.
		// `sel` = cursor row; for radio the cursor row IS the chosen one.
		const glyphFor = (optIdx: number, sel: boolean): string => {
			const g = selectionGlyph({
				multi: isMulti,
				selected: sel,
				checked: this.multiChecked.has(optIdx),
			});
			// width-safety fallback only affects the checkbox pair
			const glyph = isMulti
				? this.multiChecked.has(optIdx)
					? box.checked
					: box.unchecked
				: g.glyph;
			return t.fg(g.color as Parameters<typeof t.fg>[0], glyph);
		};

		if (total === 0) return [t.fg("warning", "No options")];

		// Render the complete logical list. frameModal owns the only viewport, so
		// PageUp/PageDown can inspect every option without a nested 12-item crop.
		const start = 0;
		const end = total;

		const lines: string[] = [];
		this.selectedOptionRows = undefined;
		// Hang-indent descriptions under the LABEL column, not the pointer.
		// Prefix is `→ G ` = ptr(1)+sp(1)+glyph(1)+sp(1) = 4 cols.
		const LABEL_COL = 4;
		const pad = " ".repeat(LABEL_COL);

		for (let i = start; i < end; i++) {
			const item = items[i];
			if (!item) continue;
			const sel = i === this.selectedOptionIndex;
			const ptr = sel ? t.fg("accent", "→") : " ";

			// Visually separate the "Confirm" commit row from the choices above it.
			if (item.kind === "next" && lines.length > 0) lines.push("");

			const itemStart = lines.length;
			if (item.kind === "option" && item.option) {
				const optIdx = this.filteredOptions.indexOf(item.option);
				const glyph = glyphFor(optIdx, sel);
				const label = sel
					? t.fg("accent", t.bold(item.option.label))
					: t.fg("text", t.bold(item.option.label));
				lines.push(truncateToWidth(`${ptr} ${glyph} ${label}`, inner, ""));
				if (item.option.description) {
					const wrapped = wrapTextWithAnsi(
						item.option.description,
						Math.max(10, inner - LABEL_COL),
					);
					for (const w of wrapped) {
						lines.push(truncateToWidth(`${pad}${t.fg("muted", w)}`, inner, ""));
					}
				}
			} else if (item.kind === "other") {
				const label = sel
					? t.fg("accent", t.bold(SENTINEL_FREEFORM))
					: t.fg("text", t.bold(SENTINEL_FREEFORM));
				lines.push(truncateToWidth(`${ptr} ${t.fg("dim", "✎")} ${label}`, inner, ""));
			} else if (item.kind === "next") {
				const label = sel
					? t.fg("accent", t.bold(SENTINEL_NEXT))
					: t.fg("text", t.bold(SENTINEL_NEXT));
				lines.push(truncateToWidth(`${ptr} ${t.fg("dim", "→")} ${label}`, inner, ""));
			}
			if (sel)
				this.selectedOptionRows = { start: itemStart, end: Math.max(itemStart + 1, lines.length) };
		}

		return lines;
	}

	private renderPreview(width: number): string[] {
		const item = this.selectedItem;
		if (item?.kind !== "option" || !item.option?.preview) {
			return [this.theme.fg("dim", "No preview")];
		}

		const mdText = item.option.preview;
		const mdWidth = Math.max(10, width);

		if (this.mdTheme) {
			const md = new Markdown(`## ${item.option.label}\n\n${mdText}`, 0, 0, this.mdTheme);
			return md.render(mdWidth);
		}

		const lines = wrapTextWithAnsi(mdText, mdWidth);
		return lines.map((l) => truncateToWidth(this.theme.fg("muted", l), mdWidth, ""));
	}

	override render(termWidth: number): string[] {
		// Cap to a fixed-width floating modal; render content at the inner width
		// and frame it with a rounded border (see frameLines).
		const mw = modalWidth(termWidth);
		const width = mw - 4; // border (2) + padding (2)
		const inner = Math.max(20, width);
		const t = this.theme;
		const isMulti = !!this.currentQ.multiSelect;
		const hasPreview =
			!isMulti && this.selectedItem?.kind === "option" && !!this.selectedItem?.option?.preview;

		const useSplit = hasPreview && width >= SPLIT_PANE_MIN_WIDTH;
		const leftWidth = useSplit ? Math.floor((width - 2) * 0.45) : inner;
		const previewWidth = useSplit ? Math.max(20, width - leftWidth - 3) : 0;

		const header: string[] = [];
		const body: string[] = [];
		let footer: string[] = [];

		const row = (content: string): string => truncateToWidth(content, width, "");
		const guide = (key: string, action: string) => t.fg("text", key) + t.fg("dim", ` ${action}`);
		const guideSep = t.fg("dim", " • ");

		// Tab bar — rendered as the framed top edge (frameLines `top`).
		let top: string | undefined;
		if (this.params.questions.length > 1) {
			const tabParts: string[] = [];
			for (let i = 0; i < this.params.questions.length; i++) {
				const active = i === this.currentIndex;
				const tag = `${i + 1}.${this.params.questions[i]?.header}`;
				tabParts.push(active ? t.fg("accent", t.bold(tag)) : t.fg("dim", tag));
			}
			top = truncateToWidth(tabParts.join(t.fg("dim", "  ")), width, "");
		}

		// Header chip
		const chip = t.fg("accent", t.bold(this.currentQ.header));
		const prog =
			this.params.questions.length > 1
				? dim(t)(` ${this.currentIndex + 1}/${this.params.questions.length}`)
				: "";
		header.push(row(`${chip}${prog}`));

		// Question text
		for (const w of wrapTextWithAnsi(this.currentQ.question, Math.max(10, inner))) {
			header.push(row(t.fg("text", t.bold(w))));
		}

		// Input mode
		if (this.inputMode) {
			header.push("");
			header.push(row(t.fg("accent", t.bold("Type your response:"))));
			body.push(
				...this.ensureEditor()
					.render(width)
					.map((line) => truncateToWidth(line, width, "")),
			);
			footer = [
				row(
					guide("PgUp/PgDn", "inspect") +
						guideSep +
						guide("enter", "submit") +
						guideSep +
						guide("esc", "back") +
						guideSep +
						guide("ctrl+c", "cancel"),
				),
			];
			return this.frame(mw, header, body, footer, top);
		}

		// Search bar
		if (!isMulti) {
			const searchVal = this.searchQuery
				? t.fg("text", this.searchQuery)
				: t.fg("dim", "type to filter");
			header.push(row(`${t.fg("accent", "Filter:")} ${searchVal}`));
		}

		// Options (with optional split-pane preview)
		const optionLines = this.renderOptions(useSplit ? leftWidth : width);
		const previewLines = useSplit ? this.renderPreview(previewWidth) : [];
		const maxOptLines = Math.max(optionLines.length, previewLines.length);

		if (useSplit) {
			const sep = t.fg("dim", SEPARATOR);
			for (let i = 0; i < maxOptLines; i++) {
				const left = truncateToWidth(optionLines[i] ?? "", leftWidth, "", true);
				const right = truncateToWidth(previewLines[i] ?? "", previewWidth, "");
				const splitRow = `${left || " ".repeat(leftWidth)}${sep}${right || " ".repeat(previewWidth)}`;
				body.push(truncateToWidth(splitRow, width, ""));
			}
		} else {
			for (const line of optionLines) body.push(row(line));
		}

		// Footer hints
		const hints: Array<[string, string]> = [["↑↓", "nav"]];
		if (this.params.questions.length > 1) hints.push(["←→", "question"]);
		if (isMulti) {
			hints.push(["space", "toggle"], ["enter", "commit"]);
		} else {
			hints.push(["type", "filter"], ["enter", "select"]);
		}
		hints.push(["esc", "clear"], ["ctrl+c", "cancel"], ["PgUp/PgDn", "inspect"]);
		footer = [row(hints.map(([key, action]) => guide(key, action)).join(guideSep))];

		return this.frame(mw, header, body, footer, top);
	}

	/** Frame sections with a terminal-height budget and inspectable body paging. */
	private frame(
		outerWidth: number,
		header: string[],
		body: string[],
		footer: string[],
		top: string | undefined,
	): string[] {
		const t = this.theme;
		const result = frameModal({
			width: outerWidth,
			maxHeight: terminalModalHeight(this.tui.terminal.rows),
			minHeight: MIN_MODAL_HEIGHT,
			header: [...header, ""],
			body,
			footer: ["", ...footer],
			bodyOffset: this.pager.bodyOffset,
			selectedBodyRange:
				this.selectedOptionRows === undefined
					? undefined
					: this.pager.selectedRange(this.selectedOptionRows),
			top,
			color: (s) => t.fg("accent", s),
			bg: (s) => t.bg("customMessageBg", s),
			overflowLine: ({ page, totalPages }) =>
				t.fg("dim", `PgUp/PgDn inspect • ${page}/${totalPages}`),
		});
		this.pager.sync(result);
		return result.lines;
	}
}
