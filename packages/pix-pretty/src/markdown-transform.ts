/**
 * Display transform for Markdown that Pi does not pass through its transformer chain,
 * such as cards drawn by entry renderers (`/btw`). pix-display registers the same
 * pipeline it gives assistant replies; without it the Markdown stays as written.
 * The slot lives on globalThis: Pi re-evaluates extension modules on reload.
 */
export type MarkdownTransform = (markdown: string, availableWidth: number) => string;

const KEY = Symbol.for("@xynogen/pix-pretty:markdown-transform");
type Slot = { [KEY]?: MarkdownTransform };

export function setMarkdownTransform(transform: MarkdownTransform | undefined): void {
	(globalThis as Slot)[KEY] = transform;
}

/** Pass as `Markdown`'s `transform` option. A throwing transform keeps the source, as Pi does. */
export function transformMarkdown(markdown: string, availableWidth: number): string {
	try {
		return (globalThis as Slot)[KEY]?.(markdown, availableWidth) ?? markdown;
	} catch {
		return markdown;
	}
}
