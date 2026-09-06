/** Add the @ picker to an editor without replacing its paste state or rendering. */
import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

/** Picked paths are marked as `<path>…</path>`; pix-display renders the span as a chip. */
export function pathToken(path: string): string {
	return `<path>${path}</path> `;
}

export type OpenPicker = () => Promise<string | null>;

/** A mention starts at the beginning of a line or after whitespace. */
export function atStartsMention(before: string): boolean {
	return before === "" || /\s$/.test(before);
}

export function attachPicker(
	editor: CustomEditor,
	tui: TUI,
	openPicker: OpenPicker,
	onError: (message: string) => void,
): void {
	const handleInput = editor.handleInput.bind(editor);
	let inPaste = false;
	const runPicker = async () => {
		try {
			const path = await openPicker();
			editor.insertTextAtCursor(path ? pathToken(path) : "@");
		} catch (error) {
			editor.insertTextAtCursor("@");
			onError(`File picker failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			tui.requestRender();
		}
	};
	editor.handleInput = (data: string) => {
		// Bracketed paste can arrive in separate chunks; a pasted @ is not a shortcut.
		for (const marker of data.matchAll(/\x1b\[(200|201)~/g)) {
			inPaste = marker[1] === "200";
		}
		if (!inPaste && data === "@") {
			const cursor = editor.getCursor();
			const line = editor.getLines()[cursor.line] ?? "";
			if (atStartsMention(line.slice(0, cursor.col))) {
				void runPicker();
				return;
			}
		}
		handleInput(data);
	};
}
