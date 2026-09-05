/**
 * Custom editor that opens the file picker when `@` is typed at a token
 * boundary (line start or after whitespace), instead of inserting a literal
 * `@` and relying on the inline autocomplete dropdown.
 *
 * The editor stays dumb about UI plumbing: it calls the injected `openPicker`
 * callback (wired to `ctx.ui.custom` in the extension) and inserts whatever
 * token comes back. A cancelled pick inserts a literal `@` so the keystroke is
 * never silently swallowed.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { atToken } from "./rank.ts";

// The CustomEditor constructor wants pi-coding-agent's KeybindingsManager,
// which is a structural superset of pi-tui's. The factory hands us a value the
// host already typed correctly, so we take it as the constructor's own param
// type rather than re-importing a non-exported type.
type KbManager = ConstructorParameters<typeof CustomEditor>[2];

export type OpenPicker = () => Promise<string | null>;

/** True when a literal `@` at the cursor should start an @-mention: the cursor
 *  is at line start or the preceding character is whitespace. */
export function atStartsMention(before: string): boolean {
	return before === "" || /\s$/.test(before);
}

export class AtEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KbManager,
		private readonly openPicker: OpenPicker,
	) {
		super(tui, theme, keybindings);
	}

	handleInput(data: string): void {
		if (data === "@") {
			const cursor = this.getCursor();
			const line = this.getLines()[cursor.line] ?? "";
			if (atStartsMention(line.slice(0, cursor.col))) {
				void this.runPicker();
				return;
			}
		}
		super.handleInput(data);
	}

	private async runPicker(): Promise<void> {
		const path = await this.openPicker();
		this.insertTextAtCursor(path ? `${atToken(path)} ` : "@");
	}
}
