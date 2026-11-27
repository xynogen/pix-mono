/**
 * The one search look for every `/pix` list (Settings, Binaries, Extensions, MCP, Tools):
 * an always-visible `Search:` line, `/` to type, live narrowing, enter keeps, esc clears.
 * Panels own the matching (substring or fuzzy); this owns the input, line, guides and empty row.
 */

import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface FilterTheme {
	fg(color: string, text: string): string;
}

export type Guide = [key: string, action: string];

export class ListFilter {
	query = "";
	private input: Input | undefined;

	/** True while the search input owns the keyboard. */
	get typing(): boolean {
		return this.input !== undefined;
	}

	open(): void {
		const input = new Input({ prompt: "" });
		input.focused = true;
		// Paste the kept query so the cursor sits at its end.
		if (this.query) input.handleInput(`\x1b[200~${this.query}\x1b[201~`);
		input.onSubmit = () => {
			this.input = undefined;
		};
		input.onEscape = () => {
			this.input = undefined;
			this.query = "";
		};
		this.input = input;
	}

	/** Feed one key to the open input. */
	handleInput(data: string): void {
		const input = this.input;
		if (!input) return;
		input.handleInput(data);
		// onEscape clears the query and closes the input. Keep that result.
		if (this.input === input) this.query = input.getValue();
	}

	/** Drop a kept query. True when there was one (esc clears it before it closes the view). */
	clear(): boolean {
		if (!this.query) return false;
		this.query = "";
		return true;
	}

	/** Case-insensitive substring match against any of `texts`. An empty query matches all. */
	matches(...texts: Array<string | undefined>): boolean {
		const q = this.query.trim().toLowerCase();
		return !q || texts.some((text) => text?.toLowerCase().includes(q));
	}

	/**
	 * The `Search:` line: input while typing, else the kept query or a hint; match count at the right edge.
	 * `label` names what the query matches when a panel has more than one search.
	 */
	line(theme: FilterTheme, width: number, shown: number, total: number, label = "Search"): string {
		const prefix = `${label}: `;
		const lead = theme.fg("muted", prefix);
		const count = this.query ? theme.fg("muted", `  ${shown} of ${total}`) : "";
		const room = Math.max(1, width - visibleWidth(prefix) - visibleWidth(count));
		if (!this.query && !this.input) return `${lead}${theme.fg("dim", "/ to search")}`;
		// Input pads its row to `room`; pad the kept query the same so the count never moves.
		const text = this.input
			? (this.input.render(room)[0] ?? "")
			: theme.fg("accent", truncateToWidth(this.query, room, "…", true));
		return `${lead}${text}${count}`;
	}

	/** Footer guides: the typing keys while the input is open, else the `/` key. */
	guides(): Guide[] {
		return this.input
			? [
					["↑↓", "move"],
					["enter", "keep"],
					["esc", "clear"],
				]
			: [["/", "search"]];
	}

	/** Body row for an empty result. */
	noMatch(theme: FilterTheme): string {
		return theme.fg("muted", `  no match for "${this.query}"`);
	}
}
