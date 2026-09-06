/**
 * pix-search — adds input handling that opens a file-picker
 * overlay when you type `@` at a token boundary. The picker owns its own query
 * input, so spaces in the query work natively (no `@"…"` quoting). It lists
 * both files and their containing folders (so you can @-mention a directory),
 * ranked by fuzzy score + git recency, with a live preview of the selection.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachPicker } from "./editor.ts";
import { FilePicker } from "./picker.ts";
import { withDirectories } from "./rank.ts";
import { loadRecency, type RecencyMap } from "./recency.ts";
import { rgFiles } from "./rg.ts";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const cwd = ctx.cwd;

		// Warm the git-recency cache in the background; picker reads whatever is
		// ready when it opens (empty until the first git log returns).
		let recency: RecencyMap = new Map();
		void loadRecency(cwd).then((map) => {
			recency = map;
		});

		// Open the picker overlay and resolve with the chosen path (or null).
		const openPicker = () =>
			ctx.ui.custom<string | null>(
				(tui, theme, _kb, done) => {
					// List files fresh each open so new/removed files are reflected.
					const controller = new AbortController();
					const picker = new FilePicker({
						files: [],
						recency,
						theme: theme as never,
						cwd,
						done,
						onChange: () => tui.requestRender(),
					});
					void rgFiles(cwd, controller.signal).then((files) =>
						picker.setFiles(withDirectories(files)),
					);
					return {
						render: (width: number) => picker.render(width),
						handleInput: (data: string) => picker.handleInput(data),
						invalidate: () => picker.invalidate(),
						dispose: () => controller.abort(),
					};
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "60%", maxHeight: "60%" } },
			);

		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			const editor = previous?.(tui, theme, kb) ?? new CustomEditor(tui, theme, kb);
			// ponytail: cursor access requires CustomEditor. Keep other editors intact;
			// add a public cursor adapter if a non-CustomEditor integration is needed.
			if (editor instanceof CustomEditor) {
				attachPicker(editor, tui, openPicker, (message) => ctx.ui.notify(message, "error"));
			} else {
				ctx.ui.notify(
					"pix-search: @ picker requires a CustomEditor; existing editor kept.",
					"warning",
				);
			}
			return editor;
		});
	});
}
