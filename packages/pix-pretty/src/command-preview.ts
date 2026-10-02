import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { hlBlock } from "./highlight.ts";
import type { ThemeLike } from "./types.ts";

export function commandPreview(
	header: string,
	code: string,
	language: string | undefined,
	theme: Pick<ThemeLike, "fg">,
	state: Record<string, unknown>,
	invalidate: () => void,
	expanded = false,
) {
	type Slot = { code: string; language: string | undefined; theme: typeof theme; styled: string };
	let slot = state.commandPreview as Slot | undefined;
	if (!slot || slot.code !== code || slot.language !== language || slot.theme !== theme) {
		slot = { code, language, theme, styled: theme.fg("dim", code) };
		state.commandPreview = slot;
		const pending = slot;
		void hlBlock(code, language, theme).then(
			(lines) => {
				if (state.commandPreview !== pending) return;
				pending.styled = lines.join("\n");
				invalidate();
			},
			() => {
				/* Plain text remains available if highlighting fails. */
			},
		);
	}
	const current = slot;
	let replacement: string | undefined;
	return {
		setText(value: string) {
			replacement = value;
		},
		getText: () => replacement ?? `${header}${theme.fg("muted", " · ")}${current.styled}`,
		invalidate() {},
		render(width: number): string[] {
			if (replacement !== undefined)
				return replacement ? new Text(replacement, 0, 0).render(width) : [];
			const separator = theme.fg("muted", " · ");
			if (!code.includes("\n") && visibleWidth(header) + 3 + visibleWidth(code) <= width) {
				return new Text(`${header}${separator}${current.styled}`, 0, 0).render(width);
			}
			// ponytail: wrap without rewriting shell syntax or quoted strings. Add a shell parser only for semantic formatting.
			const lines = wrapTextWithAnsi(current.styled, Math.max(1, width - 2));
			const shown = expanded ? lines : lines.slice(0, 16);
			return [
				truncateToWidth(`${header}${separator}`, width, "…"),
				...shown.map((line) => `  ${line}`),
				...(shown.length < lines.length
					? [theme.fg("muted", `  … +${lines.length - shown.length} lines`)]
					: []),
			];
		},
	};
}

export function collapsedCommandRow(header: string, command: string, theme: Pick<ThemeLike, "fg">) {
	let text = `${header}${theme.fg("muted", " · ")}${theme.fg("dim", command.replace(/\s+/g, " ").trim())}`;
	let replaced = false;
	return {
		setText(value: string) {
			text = value;
			replaced = true;
		},
		getText: () => text,
		invalidate() {},
		render(width: number): string[] {
			if (replaced) return text ? new Text(text, 0, 0).render(width) : [];
			return [truncateToWidth(text, width, "…")];
		},
	};
}
