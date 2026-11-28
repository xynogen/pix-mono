/**
 * The `copy` button at the end of a code frame's header row: a left click puts that
 * block's source on the system clipboard. Display only: the session keeps the raw text.
 *
 * Rows come from the same render that drew the frames, so the hit test cannot drift
 * from what the user sees.
 */
import { showTransientMessage, type TransientErrorUI } from "@xynogen/pix-pretty/transient-error";
import { getErrorMessage } from "@xynogen/pix-runtime/errors";
import { copyToClipboard } from "@xynogen/pix-runtime/host";

/** Right-aligned header label. Its width is the click target at the row's end. */
export const COPY_BUTTON = " copy ";

/** One framed block: its header row in the rendered lines, and the source it copies. */
export type CodeFrame = { row: number; text: string };

type Click = { type: string; button: string; x: number; y: number; width: number };

// Keyed by the message component that rendered the frames; rebuilt on every render.
const frames = new WeakMap<object, readonly CodeFrame[]>();

let ui: TransientErrorUI | undefined;
let write = copyToClipboard;

/** Remember the UI for feedback and the clipboard writer (tests pass a fake). */
export function initCodeCopy(target: TransientErrorUI, copy = copyToClipboard): void {
	ui = target;
	write = copy;
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

/** A left click on a frame's copy button writes that block; every other click returns false. */
export function copyCodeAt(owner: object, event: Click): boolean {
	if (event.type !== "click" || event.button !== "left") return false;
	const frame = frames.get(owner)?.find((candidate) => candidate.row === event.y);
	if (!frame || event.x < event.width - COPY_BUTTON.length) return false;
	const lines = frame.text.split("\n").length;
	void write(frame.text).then(
		() => notify(`copied ${lines} lines`, "info"),
		(error: unknown) => notify(`copy failed: ${getErrorMessage(error)}`, "warning"),
	);
	return true;
}
