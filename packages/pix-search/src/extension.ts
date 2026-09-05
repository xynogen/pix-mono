/**
 * pix-search — replaces the input editor with one that opens a file-picker
 * overlay when you type `@` at a token boundary. The picker owns its own query
 * input, so spaces in the query work natively (no `@"…"` quoting) and the
 * search is filename-only, ranked by fuzzy score + git recency.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AtEditor } from "./editor.ts";
import { FilePicker } from "./picker.ts";
import { loadRecency, type RecencyMap } from "./recency.ts";
import { rgFiles } from "./rg.ts";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
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
				(_tui, theme, _kb, done) => {
					// List files fresh each open so new/removed files are reflected.
					const controller = new AbortController();
					const picker = new FilePicker({
						files: [],
						recency,
						theme: theme as never,
						done,
					});
					void rgFiles(cwd, controller.signal).then((files) => picker.setFiles(files));
					return {
						render: (width: number) => picker.render(width),
						handleInput: (data: string) => picker.handleInput(data),
						invalidate: () => picker.invalidate(),
						dispose: () => controller.abort(),
					};
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "60%", maxHeight: "60%" } },
			);

		ctx.ui.setEditorComponent((tui, theme, kb) => new AtEditor(tui, theme, kb, openPicker));
	});
}
