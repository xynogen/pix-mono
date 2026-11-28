/**
 * Interactions on a code frame's header row: the arrow at the left folds the block,
 * the `copy` button at the right end writes its source to the system clipboard.
 *
 * Rows come from the same render that drew the frames, so a hit test cannot drift
 * from what the user sees. Display only: the session keeps the raw text.
 */
import { showTransientMessage, type TransientErrorUI } from "@xynogen/pix-pretty/transient-error";
import { getErrorMessage } from "@xynogen/pix-runtime/errors";
import { copyToClipboard } from "@xynogen/pix-runtime/host";

/** Right-aligned header label. Its width is the click target at the row's end. */
export const COPY_BUTTON = " copy ";
/** Columns taken by the fold arrow at the row's start. */
export const FOLD_ARROW = 1;

/** One framed block: its header row in the rendered lines, and the source it holds. */
export type CodeFrame = { row: number; text: string };

type Click = { type: string; button: string; x: number; y: number; width: number };
type Owner = { invalidate?(): void };

// Keyed by the message component that rendered the frames; rebuilt on every render.
const frames = new WeakMap<object, readonly CodeFrame[]>();
// Blocks the user folded, by source text, so the state survives re-renders.
const folded = new Set<string>();

let ui: TransientErrorUI | undefined;
let write = copyToClipboard;

/** Remember the UI for feedback and the clipboard writer (tests pass a fake). */
export function initCodeFrames(target: TransientErrorUI, copy = copyToClipboard): void {
	ui = target;
	write = copy;
}

export function isFolded(text: string): boolean {
	return folded.has(text);
}

/** Pi's expand key opens every block again. Returns whether anything was folded. */
export function setCodeFramesExpanded(expanded: boolean): boolean {
	if (!expanded || folded.size === 0) return false;
	folded.clear();
	return true;
}

export function rememberFrames(owner: object, list: readonly CodeFrame[]): void {
	frames.set(owner, list);
}

export function forgetFrames(owner: object): void {
	frames.delete(owner);
}

function notify(message: string, level: "info" | "warning"): void {
	if (ui) showTransientMessage(ui, message, level);
}

function copyFrame(frame: CodeFrame): void {
	const lines = frame.text.split("\n").length;
	void write(frame.text).then(
		() => notify(`copied ${lines} lines`, "info"),
		(error: unknown) => notify(`copy failed: ${getErrorMessage(error)}`, "warning"),
	);
}

/**
 * Left click on a frame's header: the arrow folds the block, the trailing `copy`
 * button writes it. Returns true when the click was ours.
 */
export function frameClickAt(owner: Owner, event: Click): boolean {
	if (event.type !== "click" || event.button !== "left") return false;
	const frame = frames.get(owner)?.find((candidate) => candidate.row === event.y);
	if (!frame) return false;
	if (event.x < FOLD_ARROW) {
		if (folded.has(frame.text)) folded.delete(frame.text);
		else folded.add(frame.text);
		owner.invalidate?.();
		return true;
	}
	if (event.x < event.width - COPY_BUTTON.length) return false;
	copyFrame(frame);
	return true;
}
