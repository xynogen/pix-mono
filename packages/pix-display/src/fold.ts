/**
 * `::fold[Title]` … `::fold`: the model marks a section to show folded.
 *
 * Folded, the section is one summary line. A left click on that line toggles the one
 * fold, like a thinking block. Pi's expand key (ctrl+o) sets every fold, like tool
 * output: Pi calls `setExpanded` on each chat component that has one, so assistant
 * messages get one here. Display only: the session keeps the raw text.
 */
import { FG_BLUE, FG_DIM, RST } from "@xynogen/pix-pretty/ansi";
import {
	AssistantMessageComponent,
	stripTerminalSequences,
	type Theme,
} from "@xynogen/pix-pretty/tui";
import { wrapMethod } from "@xynogen/pix-runtime/patch";

const FOLD = /^::fold(?:\[([^\]\n]*)\])?\s*$/;
const FENCE = /^\s*(```|~~~)/;
const HEADER = /^\s*[▸▾] /;

type Fold = { title: string; lines: string[] };
type FoldUI = { getToolsExpanded(): boolean; theme: Pick<Theme, "fg"> };

let open = false;
let accent = (text: string) => `${FG_BLUE}${text}\x1b[39m`;
// Folds the user clicked, by title and body: they keep their state across re-renders.
const clicked = new Map<string, boolean>();

const keyOf = (fold: Fold) => `${fold.title}\n${fold.lines.join("\n")}`;

/** Lines outside folds as strings, each fold as one item. A marker in a code fence stays text. */
function parse(markdown: string): (string | Fold)[] {
	const items: (string | Fold)[] = [];
	let fenced = false;
	let fold: Fold | undefined;
	for (const line of markdown.split("\n")) {
		const marker = fenced ? undefined : FOLD.exec(line);
		if (marker) {
			if (fold) items.push(fold);
			fold = fold ? undefined : { title: marker[1]?.trim() ?? "", lines: [] };
			continue;
		}
		if (FENCE.test(line)) fenced = !fenced;
		if (fold) fold.lines.push(line);
		else items.push(line);
	}
	// An unclosed fold (still streaming) runs to the end.
	if (fold) items.push(fold);
	return items;
}

/** Collapse each `::fold` section to one line, or show it whole under a header when open. */
export function renderFolds(markdown: string, expanded: boolean): string {
	if (!markdown.includes("::fold")) return markdown;
	return parse(markdown)
		.flatMap((item) => {
			if (typeof item === "string") return [item];
			const title = accent(item.title || "Folded");
			if (clicked.get(keyOf(item)) ?? expanded)
				return ["", `${accent("▾")} ${title}`, "", ...item.lines, ""];
			const meta = `${FG_DIM}· ${item.lines.length} lines (click or ctrl+o to expand)${RST}`;
			return ["", `${accent("▸")} ${title} ${meta}`, ""];
		})
		.join("\n");
}

export function foldsOpen(): boolean {
	return open;
}

const isHeader = (line: string | undefined) => HEADER.test(stripTerminalSequences(line ?? ""));

/** Each fold's header row with its key: headers appear in the order of the message's folds. */
export function foldHeaders(
	lines: readonly string[],
	texts: readonly string[],
): { row: number; key: string }[] {
	const keys = texts.flatMap((text) =>
		parse(text).flatMap((item) => (typeof item === "string" ? [] : [keyOf(item)])),
	);
	const rows = lines.flatMap((line, row) => (isHeader(line) ? [row] : []));
	return rows.flatMap((row, i) => {
		const key = keys[i];
		return key === undefined ? [] : [{ row, key }];
	});
}

/**
 * Row after an open fold's body. The rows after the fold are the same open or closed, so
 * render it closed once: its header ends at the first blank row, and what follows is that tail.
 */
function openEnd(
	component: AssistantMessageComponent,
	width: number,
	header: { row: number; key: string },
	openRows: number,
): number {
	const previous = clicked.get(header.key);
	clicked.set(header.key, false);
	component.invalidate();
	const closed = component.render(width);
	if (previous === undefined) clicked.delete(header.key);
	else clicked.set(header.key, previous);
	component.invalidate();
	let end = header.row;
	while (end < closed.length && stripTerminalSequences(closed[end] ?? "").trim()) end++;
	return openRows - (closed.length - end);
}

/** The fold under row `y`: its header, or anywhere in an open fold's body. */
function foldAt(
	component: AssistantMessageComponent,
	width: number,
	y: number,
): string | undefined {
	const lines = component.render(width);
	const above = foldHeaders(lines, textsOf(component)).filter(({ row }) => row <= y);
	const nearest = above.at(-1);
	if (!nearest) return undefined;
	if (nearest.row === y) return nearest.key;
	if (!(clicked.get(nearest.key) ?? open)) return undefined;
	return y < openEnd(component, width, nearest, lines.length) ? nearest.key : undefined;
}

function textsOf(component: object): string[] {
	const content: unknown = Reflect.get(component, "lastMessage")?.content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => String(block.text).trim());
}

/** Start state and colors from the session's UI. */
export function initFolds(ui: FoldUI): void {
	open = ui.getToolsExpanded();
	accent = (text) => ui.theme.fg("accent", text);
}

/** Click a header, or an open fold's body, to toggle it; the expand key sets all folds. */
export function followFoldInput(): void {
	Object.defineProperty(AssistantMessageComponent.prototype, "setExpanded", {
		configurable: true,
		writable: true,
		value(this: AssistantMessageComponent, expanded: boolean): void {
			open = expanded;
			clicked.clear();
			if (textsOf(this).some((text) => text.includes("::fold"))) this.invalidate();
		},
	});
	wrapMethod(
		AssistantMessageComponent.prototype,
		"handleMouse",
		(native) =>
			function foldOnClick(this: AssistantMessageComponent, event) {
				const result = native.call(this, event);
				if (result || event.type !== "click" || event.button !== "left") return result;
				const key = foldAt(this, event.width, event.y);
				if (key === undefined) return undefined;
				clicked.set(key, !(clicked.get(key) ?? open));
				this.invalidate();
				return { handled: true };
			},
	);
}
