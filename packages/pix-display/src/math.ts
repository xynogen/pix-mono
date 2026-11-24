/**
 * Display math (`$$…$$`, `\[…\]`) in assistant replies, typeset as an image.
 *
 * MathJax turns the TeX into SVG and resvg (WASM) rasterises it to PNG, both in
 * process, so the model writes plain LaTeX and needs no tool call. The image is
 * sized to text height from the formula's own metrics, not stretched to the screen.
 *
 * The engine (~110 MB) is not a dependency: the first reply with display math asks
 * once to install it into `<agentDir>/pix-display/math`, like ast-grep grammars.
 *
 * Pi's Unicode rendering stays whenever an image cannot be shown: no terminal image
 * support, engine not installed or loaded, a TeX error, or a formula wider than the screen.
 */
import { dirname, join } from "node:path";
import { FG_DIM, RST } from "@xynogen/pix-pretty/ansi";
import { type ConfirmUI, confirmOverlay } from "@xynogen/pix-pretty/confirm";
import { getCapabilities, getCellDimensions } from "@xynogen/pix-pretty/tui";
import { readFile } from "@xynogen/pix-runtime/fs";
import { installIntoPrefix } from "@xynogen/pix-runtime/npm-prefix";
import { agentDir, importFile, requireFrom } from "@xynogen/pix-runtime/paths";
import { renderImageRows } from "./image.ts";

/** SVG plus its natural size in `ex`, the unit MathJax lays math out in. */
type Typeset = (tex: string) => { svg: string; widthEx: number; heightEx: number } | undefined;
type Rasterise = (svg: string, heightPx: number) => Uint8Array;

let engine: { typeset: Typeset; rasterise: Rasterise } | undefined;
let loading: Promise<void> | undefined;
// True when the engine packages are not installed (not when they fail to load).
let missing = false;
let offered = false;

// Pinned: the renderer depends on MathJax's SVG output and resvg's API.
const MATH_PACKAGES = ["@mathjax/src@4.1.3", "@resvg/resvg-wasm@2.6.2"];
const INSTALL_TIMEOUT_MS = 300_000;
const CONFIRM_TIMEOUT_MS = 60_000;
const DISPLAY_MATH = /^ {0,3}(\$\$|\\\[)/m;

const FENCE = /^\s*(```|~~~)/;
const OPEN = /^ {0,3}(\$\$|\\\[)/;
// Glyph color; resvg needs a concrete color, not currentColor.
const INK = "#e6e6e6";
// One `ex` is about half a text row, so text-size math is `heightEx / 2` rows tall.
const ROWS_PER_EX = 0.5;
const MAX_ROWS = 8;
// Space between the formula and its frame: columns left/right, rows above/below.
const PAD_X = 2;
const PAD_Y = 1;
const MAX_CACHE = 32;
const cache = new Map<string, string[]>();

/** Install prefix for the engine packages: `<agentDir>/pix-display/math`. */
export function mathCacheDir(): string {
	return join(agentDir(), "pix-display", "math");
}

/** A `require` that finds both engine packages: the install prefix first, then this package (dev). */
function engineRequire(): NodeJS.Require | undefined {
	for (const from of [join(mathCacheDir(), "package.json"), import.meta.url]) {
		const req = requireFrom(from);
		try {
			req.resolve("@mathjax/src/mjs/mathjax.js");
			req.resolve("@resvg/resvg-wasm/index_bg.wasm");
			return req;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw err;
		}
	}
	return undefined;
}

async function load(): Promise<void> {
	const req = engineRequire();
	missing = !req;
	if (!req) return;
	const at = <T>(spec: string): Promise<T> => importFile(req.resolve(spec));
	const wasm = req.resolve("@resvg/resvg-wasm/index_bg.wasm");
	const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }, resvg] =
		await Promise.all([
			at<typeof import("@mathjax/src/mjs/mathjax.js")>("@mathjax/src/mjs/mathjax.js"),
			at<typeof import("@mathjax/src/mjs/input/tex.js")>("@mathjax/src/mjs/input/tex.js"),
			at<typeof import("@mathjax/src/mjs/output/svg.js")>("@mathjax/src/mjs/output/svg.js"),
			at<typeof import("@mathjax/src/mjs/adaptors/liteAdaptor.js")>(
				"@mathjax/src/mjs/adaptors/liteAdaptor.js",
			),
			at<typeof import("@mathjax/src/mjs/handlers/html.js")>("@mathjax/src/mjs/handlers/html.js"),
			// The ESM entry sits beside the WASM file; the package does not export its path.
			importFile<typeof import("@resvg/resvg-wasm")>(join(dirname(wasm), "index.mjs")),
			at("@mathjax/src/mjs/input/tex/base/BaseConfiguration.js"),
			at("@mathjax/src/mjs/input/tex/ams/AmsConfiguration.js"),
		]);
	// Pi's /reload re-runs this module, but Node keeps resvg's module and its WASM
	// instance, which refuses a second init. That instance is ready to use.
	await resvg.initWasm(readFile(wasm)).catch((error: unknown) => {
		if (!String(error).includes("Already initialized")) throw error;
	});
	const adaptor = liteAdaptor();
	RegisterHTMLHandler(adaptor);
	const doc = mathjax.document("", {
		InputJax: new TeX({ packages: ["base", "ams"] }),
		OutputJax: new SVG({ fontCache: "local" }),
	});
	engine = {
		typeset: (tex) => {
			const svg = adaptor.innerHTML(doc.convert(tex, { display: true }));
			// MathJax reports TeX errors inside the SVG instead of throwing.
			if (svg.includes("data-mjx-error")) return undefined;
			const widthEx = Number(/width="([\d.]+)ex"/.exec(svg)?.[1]);
			const heightEx = Number(/height="([\d.]+)ex"/.exec(svg)?.[1]);
			if (!(widthEx > 0 && heightEx > 0)) return undefined;
			return { svg: svg.replaceAll("currentColor", INK), widthEx, heightEx };
		},
		rasterise: (svg, heightPx) =>
			new resvg.Resvg(svg, { fitTo: { mode: "height", value: heightPx } }).render().asPng(),
	};
}

/**
 * Load the engine in the background. Called at extension load so it is ready
 * before the first reply; a failure leaves math on Pi's Unicode rendering.
 */
export function startMath(): Promise<void> {
	loading ??= load().catch(() => undefined);
	return loading;
}

type TextMessage = { role?: string; content?: unknown };

/** True when an assistant message has a `$$` or `\[` display-math block. */
export function hasDisplayMath(messages: readonly TextMessage[]): boolean {
	return messages.some(
		(m) =>
			m.role === "assistant" &&
			Array.isArray(m.content) &&
			m.content.some(
				(b: { type?: string; text?: unknown }) =>
					b?.type === "text" && typeof b.text === "string" && DISPLAY_MATH.test(b.text),
			),
	);
}

/**
 * Ask once per load to install the missing engine, then install it and load it.
 * Skip, a timeout, a loaded engine or no terminal image support asks nothing.
 */
export async function offerMathInstall(
	ui: ConfirmUI & { notify(message: string, type?: "info" | "warning" | "error"): void },
): Promise<void> {
	if (engine || !missing || offered || !getCapabilities().images) return;
	offered = true;
	const ok = await confirmOverlay(ui, {
		title: "Install LaTeX engine",
		body: [
			"This reply has display math. Typeset it as an image needs:",
			...MATH_PACKAGES.map((pkg) => `  ${pkg}`),
			"",
			`Download about 110 MB into ${mathCacheDir()}?`,
			"Skip keeps the plain-text rendering for this session.",
		],
		confirmLabel: "Install",
		denyLabel: "Skip",
		timeoutMs: CONFIRM_TIMEOUT_MS,
	});
	if (!ok) return;
	ui.notify("Installing the LaTeX engine…", "info");
	const result = await installIntoPrefix(mathCacheDir(), MATH_PACKAGES, {
		timeoutMs: INSTALL_TIMEOUT_MS,
	});
	if (!result.ok) {
		ui.notify(`LaTeX engine install failed: ${result.message ?? "unknown error"}`, "error");
		return;
	}
	loading = undefined;
	await startMath();
	ui.notify(
		engine
			? "LaTeX engine ready. New replies show typeset math; /reload redraws earlier ones."
			: "LaTeX engine installed, but it failed to load.",
		engine ? "info" : "error",
	);
}

/**
 * Box the image in a dim rounded frame, like the `::card` cards. Kitty only: it
 * draws without moving the cursor, so each row jumps the cursor past the image
 * (`CSI n C`) to reach the right border. iTerm2 draws from the last row with its
 * own cursor movement, so it stays unframed.
 */
function frame(image: string[], width: number): string[] {
	// The columns Pi's Image actually drew, which can differ from the requested cap.
	const cols = Number(/[;,]c=(\d+)/.exec(image[0] ?? "")?.[1]);
	if (getCapabilities().images !== "kitty" || !(cols > 0)) return image;
	const pad = " ".repeat(PAD_X);
	const skip = `\x1b[${cols}C`;
	const side = `${FG_DIM}│${RST}`;
	const rule = "─".repeat(cols + 2 * PAD_X);
	const blank = `${side}${pad}${skip}${pad}${side}`;
	// Markdown indents every row by Pi's outputPad except image rows, so indent that one here.
	// ponytail: assumes the reply spans the terminal (true for Pi's transcript).
	const margin = " ".repeat(Math.max(0, ((process.stdout.columns ?? width) - width) >> 1));
	return [
		`${FG_DIM}╭${rule}╮${RST}`,
		...Array<string>(PAD_Y).fill(blank),
		...image.map((row, i) =>
			i === 0 ? `${margin}${side}${pad}${row}${skip}${pad}${side}` : blank,
		),
		...Array<string>(PAD_Y).fill(blank),
		`${FG_DIM}╰${rule}╯${RST}`,
	];
}

/** Image rows for one display formula, or undefined to keep Pi's own rendering. */
export function renderMath(tex: string, width: number): string[] | undefined {
	if (!engine || !getCapabilities().images) return undefined;
	const key = `${tex}\0${width}`;
	const hit = cache.get(key);
	if (hit) return hit;
	let math: ReturnType<Typeset>;
	try {
		math = engine.typeset(tex);
	} catch {
		math = undefined;
	}
	if (!math) return undefined;
	// Size from the formula, not the screen: Pi's Image fills its width cap otherwise.
	const cell = getCellDimensions();
	const rows = Math.max(1, Math.min(MAX_ROWS, Math.round(math.heightEx * ROWS_PER_EX)));
	const cols = Math.ceil((rows * cell.heightPx * math.widthEx) / math.heightEx / cell.widthPx);
	if (cols > width) return undefined;
	// Rasterise at 2× the displayed height so the glyphs stay sharp.
	const png = engine.rasterise(math.svg, rows * cell.heightPx * 2);
	const image = renderImageRows(Buffer.from(png).toString("base64"), "image/png", width, {
		maxWidthCells: cols,
		maxHeightCells: rows,
	});
	const lines = cols + 2 + 2 * PAD_X <= width ? frame(image, width) : image;
	cache.set(key, lines);
	if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value ?? "");
	return lines;
}

/** Index of the line that closes the block opened on line `start`, or -1. */
function blockEnd(lines: readonly string[], start: number, closer: string): number {
	const first = (lines[start] ?? "").trim();
	// `$$x$$` or `\[x\]` on one line.
	if (first.length > 2 * closer.length && first.endsWith(closer)) return start;
	for (let j = start + 1; j < lines.length; j++) {
		if ((lines[j] ?? "").trimEnd().endsWith(closer)) return j;
	}
	return -1;
}

/** Replace display-math blocks with image rows; anything not rendered keeps its source. */
export function renderMathBlocks(markdown: string, width: number): string {
	if (!engine || (!markdown.includes("$$") && !markdown.includes("\\["))) return markdown;
	const lines = markdown.split("\n");
	const out: string[] = [];
	let fenced = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (FENCE.test(line)) fenced = !fenced;
		const opener = fenced ? undefined : OPEN.exec(line)?.[1];
		const closer = opener === "$$" ? "$$" : "\\]";
		const end = opener ? blockEnd(lines, i, closer) : -1;
		const tex =
			end < 0
				? ""
				: lines
						.slice(i, end + 1)
						.join("\n")
						.trim()
						.slice(opener?.length ?? 0, -closer.length)
						.trim();
		const rows = tex ? renderMath(tex, width) : undefined;
		if (!rows) {
			out.push(line);
			continue;
		}
		out.push("", ...rows, "");
		i = end;
	}
	return out.join("\n");
}
