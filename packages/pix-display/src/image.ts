/**
 * `::image[alt]{src="file:///abs/path.png" width=40}` — a local image in an
 * assistant reply. Display only, like the other directives.
 *
 * Only `file://` URLs and absolute paths: a remote image is downloaded first by a
 * visible tool call, so rendering never touches the network.
 */
import { fileURLToPath } from "node:url";
import { FG_DIM, RST } from "@xynogen/pix-pretty/ansi";
import { getImageDimensions, Image } from "@xynogen/pix-pretty/tui";
import { readFileSync, statSync } from "@xynogen/pix-runtime/fs";

const IMAGE = /^::image\[([^\]\n]*)\](?:\{([^}\n]*)\})?\s*$/;
// Read synchronously during render, so bound the bytes one directive can load.
const MAX_BYTES = 8 * 1024 * 1024;
const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};
const NBSP = "\u00a0";

export type ImageDirective = { alt: string; src: string; width?: number };

export function parseImage(
	line: string,
	attrs: (raw: string | undefined) => Record<string, string>,
): ImageDirective | undefined {
	const match = IMAGE.exec(line);
	if (!match) return undefined;
	const { src, width } = attrs(match[2]);
	if (!src) return undefined;
	const cells = Number(width);
	return { alt: match[1] ?? "", src, width: cells > 0 ? cells : undefined };
}

/** Absolute local path for `file://` URLs and absolute paths; undefined for anything else. */
export function localPath(src: string): string | undefined {
	if (src.startsWith("file://")) {
		try {
			return fileURLToPath(src);
		} catch {
			return undefined;
		}
	}
	return src.startsWith("/") ? src : undefined;
}

// Pi may re-render a message many times; keep the encoded rows per file version and width.
// Insertion-ordered, so dropping the first key evicts the oldest entry.
const cache = new Map<string, string[]>();
const MAX_CACHE = 16;

/** A dim one-line reason the image is not shown. Markdown punctuation is escaped. */
function note(text: string): string[] {
	return [`${FG_DIM}(image: ${text.replace(/[\\`*_]/g, "\\$&")})${RST}`];
}

/**
 * Rows for one image: terminal image sequences when the terminal supports them, else
 * Pi's text fallback. Blank rows are kept as NBSP so Markdown reserves the image height.
 */
export function renderImage(image: ImageDirective, width: number): string[] {
	const path = localPath(image.src);
	if (!path) return note(`${image.alt || image.src}: only file:// or absolute paths`);
	const mime = MIME[path.split(".").pop()?.toLowerCase() ?? ""];
	if (!mime) return note(`${image.alt || path}: unsupported type`);
	let size: number;
	let mtime: number;
	try {
		({ size, mtimeMs: mtime } = statSync(path));
	} catch {
		return note(`${image.alt || path}: not found`);
	}
	if (size > MAX_BYTES) return note(`${image.alt || path}: larger than 8 MB`);
	const key = `${path}\0${mtime}\0${size}\0${width}\0${image.width ?? ""}`;
	const hit = cache.get(key);
	if (hit) return hit;
	let data: string;
	try {
		data = readFileSync(path).toString("base64");
	} catch {
		return note(`${image.alt || path}: unreadable`);
	}
	const rows = renderImageRows(data, mime, width, {
		maxWidthCells: Math.min(image.width ?? 60, width),
		filename: path.split("/").pop(),
	});
	cache.set(key, rows);
	if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value ?? "");
	return rows;
}

type RowOptions = { maxWidthCells: number; maxHeightCells?: number; filename?: string };

/** Image rows through Pi's `Image`; blank rows become NBSP so Markdown keeps the height. */
export function renderImageRows(
	data: string,
	mime: string,
	width: number,
	options: RowOptions,
): string[] {
	const dims = getImageDimensions(data, mime) ?? undefined;
	return new Image(data, mime, { fallbackColor: (s) => `${FG_DIM}${s}${RST}` }, options, dims)
		.render(width)
		.map((row) => row || NBSP);
}
