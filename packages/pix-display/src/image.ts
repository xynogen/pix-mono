/**
 * `::image[alt]{src="file:///abs/path.png" width=40}` — a local image in an
 * assistant reply. Display only, like the other directives.
 *
 * Only `file://` URLs and absolute paths: a remote image is downloaded first by a
 * visible tool call, so rendering never touches the network.
 */
import { basename } from "node:path";
import { FG_DIM, RST } from "@xynogen/pix-pretty/ansi";
import {
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	Image,
} from "@xynogen/pix-pretty/tui";
import { readFileSync, statSync } from "@xynogen/pix-runtime/fs";
import { localFilePath, requireFrom } from "@xynogen/pix-runtime/paths";

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
	const path = localFilePath(image.src);
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
		filename: basename(path),
	});
	cache.set(key, rows);
	if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value ?? "");
	return rows;
}

type RowOptions = { maxWidthCells: number; maxHeightCells?: number; filename?: string };
type Dimensions = { widthPx: number; heightPx: number };

/** Image rows through Pi's `Image`; blank rows become NBSP so Markdown keeps the height. */
export function renderImageRows(
	data: string,
	mime: string,
	width: number,
	options: RowOptions,
): string[] {
	const source = getImageDimensions(data, mime) ?? undefined;
	const png =
		source && getCapabilities().images ? fitToCells(data, source, width, options) : undefined;
	const [shown, type] = png ? [png, "image/png"] : [data, mime];
	const dims = getImageDimensions(shown, type) ?? undefined;
	return new Image(shown, type, { fallbackColor: (s) => `${FG_DIM}${s}${RST}` }, options, dims)
		.render(width)
		.map((row) => row || NBSP);
}

type PhotonImage = { get_bytes(): Uint8Array; free(): void };
type Photon = {
	PhotonImage: { new_from_byteslice(bytes: Uint8Array): PhotonImage };
	resize(image: PhotonImage, width: number, height: number, filter: number): PhotonImage;
};
// photon's SamplingFilter.Lanczos3, the filter Pi's own image resize uses.
const LANCZOS3 = 5;
let photon: Photon | null | undefined;

/** Pi's photon-node (a Pi dependency, not ours): the running CLI's copy, else the peer install's. */
function loadPhoton(): Photon | null {
	if (photon !== undefined) return photon;
	photon = null;
	const hosts = [
		() => process.argv[1] ?? "",
		// ESM-only package (no `require` export): resolve it the ESM way.
		() => import.meta.resolve("@earendil-works/pi-coding-agent"),
	];
	for (const host of hosts) {
		try {
			// SAFETY: photon-node is CommonJS with this API; Pi's utils/photon.ts makes the same calls.
			photon = requireFrom(host())("@silvia-odwyer/photon-node") as Photon;
			break;
		} catch {
			// Not resolvable from this host: try the next one.
		}
	}
	return photon;
}

/**
 * The image as a PNG no larger than the pixels its cells show, or undefined when it
 * already fits or cannot be resized. A terminal shows no more than that anyway, and
 * herdr drops a Kitty image whose decoded RGBA exceeds its transfer budget (~30 MB).
 * The box mirrors Pi's `Image`: `width - 2` columns, square-ish rows by default. One
 * extra cell each way absorbs callers' rounding, so a raster sized to its cells stays.
 * ponytail: synchronous (render is sync) and no EXIF rotation; a huge photo costs ~1 s
 * once per cache entry. Upgrade path: Pi's async `resizeImage` plus a transcript redraw.
 */
function fitToCells(data: string, source: Dimensions, width: number, options: RowOptions) {
	const cell = getCellDimensions();
	const cols = Math.max(1, Math.min(width - 2, options.maxWidthCells));
	const rows = options.maxHeightCells ?? Math.ceil((cols * cell.widthPx) / cell.heightPx);
	if (source.widthPx <= (cols + 1) * cell.widthPx && source.heightPx <= (rows + 1) * cell.heightPx)
		return undefined;
	const scale = Math.min(
		(cols * cell.widthPx) / source.widthPx,
		(rows * cell.heightPx) / source.heightPx,
	);
	const lib = loadPhoton();
	if (!lib) return undefined;
	let image: PhotonImage | undefined;
	let out: PhotonImage | undefined;
	try {
		image = lib.PhotonImage.new_from_byteslice(Buffer.from(data, "base64"));
		const w = Math.max(1, Math.round(source.widthPx * scale));
		const h = Math.max(1, Math.round(source.heightPx * scale));
		out = lib.resize(image, w, h, LANCZOS3);
		return Buffer.from(out.get_bytes()).toString("base64");
	} catch {
		// Undecodable source: show it unchanged and let Pi's Image fall back.
		return undefined;
	} finally {
		out?.free();
		image?.free();
	}
}

// Space between an image and its frame: columns left/right, rows above/below.
const PAD_X = 2;
const PAD_Y = 1;
/** Columns the frame adds around an image. */
export const FRAME_COLS = 2 + 2 * PAD_X;

/**
 * Box image rows in a dim rounded frame, like the `::card` cards, when it fits in
 * `width`. Kitty only: it draws without moving the cursor, so each row writes spaces
 * over the image cells to reach the right border. Spaces, not a cursor jump: a jump
 * leaves the cells unpainted, so a card background has a hole there and old text
 * shows through a transparent image. Kitty keeps an image when text is written
 * under it. iTerm2 draws from the last row with its own cursor movement, so it
 * stays unframed.
 */
export function frameImage(image: string[], width: number): string[] {
	// The columns Pi's Image actually drew, which can differ from the requested cap.
	const cols = Number(/[;,]c=(\d+)/.exec(image[0] ?? "")?.[1]);
	if (getCapabilities().images !== "kitty" || !(cols > 0) || cols + FRAME_COLS > width) {
		return image;
	}
	const pad = " ".repeat(PAD_X);
	const under = " ".repeat(cols);
	const side = `${FG_DIM}│${RST}`;
	const rule = "─".repeat(cols + 2 * PAD_X);
	const blank = `${side}${pad}${under}${pad}${side}`;
	// Markdown indents every row by its paddingX except image rows, so indent that one here.
	// ponytail: assumes Markdown spans its parent with equal paddingX on both sides (Pi's
	// transcript, and cards that pad their Markdown rather than their Box).
	const margin = " ".repeat(Math.max(0, ((process.stdout.columns ?? width) - width) >> 1));
	return [
		`${FG_DIM}╭${rule}╮${RST}`,
		...Array<string>(PAD_Y).fill(blank),
		...image.map((row, i) =>
			i === 0 ? `${margin}${side}${pad}${row}${under}${pad}${side}` : blank,
		),
		...Array<string>(PAD_Y).fill(blank),
		`${FG_DIM}╰${rule}╯${RST}`,
	];
}
