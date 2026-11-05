import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { hlBlock } from "./highlight.ts";
import { fadePaint, fadeRowsOf, fadeText } from "./text.ts";
import type { ThemeLike } from "./types.ts";
import { type ExpandHintCtx, expandHint, type formatCollapsedToolRow } from "./utils.ts";

export function commandPreview(
	header: string,
	code: string,
	language: string | undefined,
	theme: Pick<ThemeLike, "fg">,
	state: Record<string, unknown>,
	invalidate: () => void,
	expanded = false,
	/** Body column: under the tool name (2-col status glyph + space). */
	indent = 3,
	/** Renderer context: expand key and whether streamed arguments are ready to highlight. */
	ctx?: ExpandHintCtx & { executionStarted?: boolean },
) {
	if (ctx?.executionStarted === false) language = undefined;
	type Slot = { code: string; language: string | undefined; theme: typeof theme; styled: string };
	let slot = state.commandPreview as Slot | undefined;
	if (!slot || slot.code !== code || slot.language !== language || slot.theme !== theme) {
		slot = { code, language, theme, styled: language ? theme.fg("dim", code) : code };
		state.commandPreview = slot;
		const pending = slot;
		if (language)
			void hlBlock(code, language, theme).then(
				(lines) => {
					if (state.commandPreview !== pending) return;
					const styled = lines.join("\n");
					if (pending.styled === styled) return;
					pending.styled = styled;
					invalidate();
				},
				() => {
					/* Plain text remains available if highlighting fails. */
				},
			);
	}
	const current = slot;
	let replacement: string | undefined;
	const text = new Text("", 0, 0);
	let memo:
		| { width: number; styled: string; replacement: string | undefined; lines: string[] }
		| undefined;
	const layout = (width: number): string[] => {
		if (replacement !== undefined) {
			text.setText(replacement);
			return replacement ? text.render(width) : [];
		}
		const separator = theme.fg("muted", " · ");
		if (!code.includes("\n") && visibleWidth(header) + 3 + visibleWidth(code) <= width) {
			text.setText(`${header}${separator}${current.styled}`);
			return text.render(width);
		}
		// ponytail: preserve shell syntax with native wrapping; use a parser only for semantic formatting.
		const padding = " ".repeat(indent);
		const lines = wrapTextWithAnsi(current.styled, Math.max(1, width - indent));
		const shown = expanded ? lines : fadeRowsOf(lines.slice(0, 17), theme, 16);
		return [
			truncateToWidth(`${header}${separator}`, width, "…"),
			...shown.map((line) => `${padding}${line}`),
			...(shown.length < lines.length
				? [
						`${theme.fg("muted", `${padding}… +${lines.length - shown.length} lines `)}${expandHint(theme, ctx)}`,
					]
				: []),
		];
	};
	return {
		setText(value: string) {
			replacement = value;
		},
		getText: () => replacement ?? `${header}${theme.fg("muted", " · ")}${current.styled}`,
		invalidate() {
			memo = undefined;
			text.invalidate();
		},
		render(width: number): string[] {
			if (
				memo?.width === width &&
				memo.styled === current.styled &&
				memo.replacement === replacement
			)
				return memo.lines;
			const lines = layout(width);
			memo = { width, styled: current.styled, replacement, lines };
			return lines;
		},
	};
}

export function collapsedCommandRow(
	header: string,
	command: string,
	theme: Pick<ThemeLike, "fg"> &
		Pick<Parameters<typeof formatCollapsedToolRow>[0], "colors" | "style">,
) {
	const plain = command.replace(/\s+/g, " ").trim();
	const prefix = `${header}${theme.fg("muted", " · ")}`;
	let text = `${prefix}${theme.fg("dim", plain)}`;
	let replaced = false;
	const replacementText = new Text("", 0, 0);
	let memo: { width: number; text: string; replaced: boolean; lines: string[] } | undefined;
	return {
		setText(value: string) {
			text = value;
			replaced = true;
		},
		getText: () => text,
		invalidate() {
			memo = undefined;
			replacementText.invalidate();
		},
		render(width: number): string[] {
			if (memo?.width === width && memo.text === text && memo.replaced === replaced)
				return memo.lines;
			if (replaced) {
				replacementText.setText(text);
				const lines = text ? replacementText.render(width) : [];
				memo = { width, text, replaced, lines };
				return lines;
			}
			const room = width - visibleWidth(prefix);
			const lines = [
				room > 0
					? `${prefix}${fadeText(plain, room, fadePaint(theme))}`
					: truncateToWidth(prefix, width, "…"),
			];
			memo = { width, text, replaced, lines };
			return lines;
		},
	};
}
