/**
 * Mermaid diagrams (```mermaid fences) in assistant replies, drawn as an image.
 *
 * beautiful-mermaid lays the diagram out as SVG with no DOM, and resvg (WASM, shared
 * with math.ts) rasterises it with the Inter font it is designed for. The image is
 * sized from the diagram's own font size, so its text matches a text row.
 *
 * The engine (~17 MB) is not a dependency: the first reply with a diagram asks once to
 * install it into `<agentDir>/pix-display/mermaid`. Installing also turns Pi's own text
 * Mermaid off (`markdown.mermaid: "off"`), because Pi's transformer runs before
 * extensions and would turn the fence into text first. It takes effect after /reload.
 *
 * Without the engine, image support, or a supported diagram, the block falls back to
 * beautiful-mermaid's text drawing, or to the plain code block when that fails too.
 */
import { join } from "node:path";
import { type ConfirmUI, confirmOverlay } from "@xynogen/pix-pretty/confirm";
import { getCapabilities, getCellDimensions } from "@xynogen/pix-pretty/tui";
import { existsSync, readFile, readFileSync } from "@xynogen/pix-runtime/fs";
import { installIntoPrefix } from "@xynogen/pix-runtime/npm-prefix";
import { agentDir, importFile, requireFrom } from "@xynogen/pix-runtime/paths";
import { setPiSettings } from "@xynogen/pix-runtime/pi-settings";
import { FRAME_COLS, frameImage, renderImageRows } from "./image.ts";

type Svg = (source: string) => string;
type Text = (source: string) => string;
type Rasterise = (svg: string, heightPx: number) => Uint8Array;

let engine: { svg: Svg; text: Text; rasterise: Rasterise } | undefined;
let loading: Promise<void> | undefined;
// True when the engine packages are not installed (not when they fail to load).
let missing = false;
let offered = false;

// Pinned: flatten() depends on beautiful-mermaid's SVG shape; Inter 3 ships TTF.
const MERMAID_PACKAGES = [
	"beautiful-mermaid@1.1.3",
	"@resvg/resvg-wasm@2.6.2",
	"inter-font@3.19.0",
];
const INTER_WEIGHTS = ["Regular", "Medium", "SemiBold", "Bold"];
const INSTALL_TIMEOUT_MS = 300_000;
const CONFIRM_TIMEOUT_MS = 60_000;

const FENCE = /^ {0,3}(```|~~~)\s*mermaid\s*$/;
// Tokyo Night, beautiful-mermaid's own palette for Pix's default theme.
const COLORS = {
	bg: "#1a1b26",
	fg: "#a9b1d6",
	line: "#3d59a1",
	accent: "#7aa2f7",
	muted: "#565f89",
};
// Node labels are 13px in beautiful-mermaid's layout; ZOOM sets how many text rows that is.
const TEXT_PX = 13;
const ZOOM = 1;
const MAX_ROWS = 40;
const MAX_CACHE = 16;
const cache = new Map<string, string[]>();

/** Install prefix for the engine packages: `<agentDir>/pix-display/mermaid`. */
export function mermaidCacheDir(): string {
	return join(agentDir(), "pix-display", "mermaid");
}

type EnginePaths = { mermaid: string; resvg: string; wasm: string; fonts: string };

/**
 * Engine files, from the install prefix first, then this package (dev). Each package is
 * resolved on its own: bun keeps every package in a separate folder.
 */
function enginePaths(): EnginePaths | undefined {
	for (const base of [mermaidCacheDir(), import.meta.dirname]) {
		const req = requireFrom(join(base, "package.json"));
		try {
			const wasm = req.resolve("@resvg/resvg-wasm/index_bg.wasm");
			const fonts = join(req.resolve("inter-font/ttf/Inter-Regular.ttf"), "..");
			// beautiful-mermaid has no require entry: walk up node_modules like Node does.
			const mermaid = req.resolve
				.paths("beautiful-mermaid")
				?.map((dir) => join(dir, "beautiful-mermaid", "dist", "index.js"))
				.find((file) => existsSync(file));
			if (mermaid) return { mermaid, resvg: join(wasm, "..", "index.mjs"), wasm, fonts };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw err;
		}
	}
	return undefined;
}

/** `#rrggbb` mixed with another, `pct` percent of the first (CSS color-mix in srgb). */
function mix(a: string, pct: number, b: string): string {
	const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
	return `#${[0, 1, 2]
		.map((i) =>
			Math.round((channel(a, i) * pct + channel(b, i) * (100 - pct)) / 100)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

const VAR = /var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g;
const MIX = /color-mix\(in srgb,\s*(#[0-9a-f]{6})\s*(\d+)%,\s*(#[0-9a-f]{6})(?:\s*\d+%)?\)/gi;

/**
 * Inline the SVG's CSS custom properties and `color-mix()` as hex: resvg evaluates
 * neither. Drops the `<style>` block too, whose web-font `@import` resvg cannot load.
 */
export function flattenSvg(svg: string): string {
	const defs = new Map<string, string>();
	for (const m of svg.matchAll(/(--[\w-]+)\s*:\s*([^;"]+)[;"]/g)) {
		if (m[1] && m[2] && !defs.has(m[1])) defs.set(m[1], m[2].trim());
	}
	const resolve = (text: string): string => {
		// Variables nest a few levels deep (`--_line` → `--line` → hex); stop when stable.
		for (let i = 0; i < 8; i++) {
			const next = text
				.replace(VAR, (_, name: string, fallback?: string) => defs.get(name) ?? fallback ?? "none")
				.replace(MIX, (_, a: string, pct: string, b: string) =>
					mix(a.toLowerCase(), Number(pct), b.toLowerCase()),
				);
			if (next === text) return next;
			text = next;
		}
		return text;
	};
	for (const [key, value] of defs) defs.set(key, resolve(value));
	return resolve(svg.replace(/<style>[\s\S]*?<\/style>/, "").replace(/\sstyle="[^"]*"/, ""));
}

async function load(): Promise<void> {
	const paths = enginePaths();
	missing = !paths;
	if (!paths) return;
	const [bm, resvg] = await Promise.all([
		importFile<typeof import("beautiful-mermaid")>(paths.mermaid),
		importFile<typeof import("@resvg/resvg-wasm")>(paths.resvg),
	]);
	// Shared with math.ts: Node keeps one resvg WASM instance, which refuses a second init.
	await resvg.initWasm(readFile(paths.wasm)).catch((error: unknown) => {
		if (!String(error).includes("Already initialized")) throw error;
	});
	const fontBuffers = INTER_WEIGHTS.map((weight) =>
		readFileSync(join(paths.fonts, `Inter-${weight}.ttf`)),
	);
	engine = {
		svg: (source) =>
			flattenSvg(bm.renderMermaidSVG(source, { ...COLORS, transparent: true, padding: 8 })),
		text: (source) => bm.renderMermaidASCII(source),
		rasterise: (svg, heightPx) =>
			new resvg.Resvg(svg, {
				fitTo: { mode: "height", value: heightPx },
				// Transparent, like math: frameImage writes spaces under the image, so the cells
				// hold the surrounding background (a card's color) and no old text.
				font: { fontBuffers, defaultFontFamily: "Inter", loadSystemFonts: false },
			})
				.render()
				.asPng(),
	};
}

/** Load the engine in the background; a failure keeps the plain code block. */
export function startMermaid(): Promise<void> {
	loading ??= load().catch(() => undefined);
	return loading;
}

type TextMessage = { role?: string; content?: unknown };

/** True when an assistant message has a ```mermaid fence. */
export function hasMermaid(messages: readonly TextMessage[]): boolean {
	return messages.some(
		(m) =>
			m.role === "assistant" &&
			Array.isArray(m.content) &&
			m.content.some(
				(b: { type?: string; text?: unknown }) =>
					b?.type === "text" &&
					typeof b.text === "string" &&
					b.text.split("\n").some((line) => FENCE.test(line)),
			),
	);
}

/**
 * Turn Pi's own text Mermaid off in the user's settings.json, so ```mermaid reaches
 * this extension. Returns "changed", "already" when it was off, or "failed".
 */
function disablePiMermaid(): "changed" | "already" | "failed" {
	try {
		return setPiSettings({ markdown: { mermaid: "off" } }) ? "changed" : "already";
	} catch {
		return "failed";
	}
}

type NotifyUI = { notify(message: string, type?: "info" | "warning" | "error"): void };

/**
 * With the engine ready, make sure Pi's text Mermaid is off, and say once that /reload
 * applies it. Covers an engine that was already there (dev, or an earlier install).
 */
function handOver(ui: NotifyUI): void {
	const result = disablePiMermaid();
	if (result === "already") return;
	ui.notify(
		result === "changed"
			? 'Pix draws Mermaid now: Pi\'s markdown.mermaid is set to "off". Run /reload to apply.'
			: 'Set "markdown": { "mermaid": "off" } in settings.json, then /reload, so Pix draws Mermaid.',
		result === "changed" ? "info" : "warning",
	);
}

/**
 * Ask once per load to install the missing engine, then install and load it.
 * Skip, a timeout, a loaded engine or no terminal image support asks nothing.
 */
export async function offerMermaidInstall(ui: ConfirmUI & NotifyUI): Promise<void> {
	if (offered || !getCapabilities().images) return;
	if (engine) {
		offered = true;
		handOver(ui);
		return;
	}
	if (!missing) return;
	offered = true;
	const ok = await confirmOverlay(ui, {
		title: "Install Mermaid renderer",
		body: [
			"This reply has a Mermaid diagram. Drawing it as an image needs:",
			...MERMAID_PACKAGES.map((pkg) => `  ${pkg}`),
			"",
			`Download about 17 MB into ${mermaidCacheDir()}?`,
			'It also sets Pi\'s markdown.mermaid to "off" so Pix draws the diagrams.',
			"Skip keeps the plain-text rendering for this session.",
		],
		confirmLabel: "Install",
		denyLabel: "Skip",
		timeoutMs: CONFIRM_TIMEOUT_MS,
	});
	if (!ok) return;
	ui.notify("Installing the Mermaid renderer…", "info");
	const result = await installIntoPrefix(mermaidCacheDir(), MERMAID_PACKAGES, {
		timeoutMs: INSTALL_TIMEOUT_MS,
	});
	if (!result.ok) {
		ui.notify(`Mermaid renderer install failed: ${result.message ?? "unknown error"}`, "error");
		return;
	}
	loading = undefined;
	await startMermaid();
	if (!engine) {
		ui.notify("Mermaid renderer installed, but it failed to load.", "error");
		return;
	}
	handOver(ui);
}

/** Image rows for one diagram, or undefined when it cannot be drawn as an image. */
export function renderMermaidImage(source: string, width: number): string[] | undefined {
	if (!engine || !getCapabilities().images) return undefined;
	const key = `${source}\0${width}`;
	const hit = cache.get(key);
	if (hit) return hit;
	let svg: string;
	try {
		svg = engine.svg(source);
	} catch {
		return undefined;
	}
	const [, , w, h] = (/viewBox="([^"]+)"/.exec(svg)?.[1] ?? "").split(/\s+/).map(Number);
	if (!(w && h && w > 0 && h > 0)) return undefined;
	// Size from the diagram, like math.ts: its label text lands at ZOOM text rows.
	const cell = getCellDimensions();
	const scale = (ZOOM * cell.heightPx) / TEXT_PX;
	let cols = Math.ceil((w * scale) / cell.widthPx);
	let rows = Math.ceil((h * scale) / cell.heightPx);
	// Too wide or tall: shrink to fit, frame included; the text gets smaller than a row.
	const shrink = Math.min(1, (width - FRAME_COLS) / cols, MAX_ROWS / rows);
	cols = Math.max(1, Math.floor(cols * shrink));
	rows = Math.max(1, Math.floor(rows * shrink));
	// Rasterise at 2× the displayed height so text and lines stay sharp.
	let png: Uint8Array;
	try {
		png = engine.rasterise(svg, rows * cell.heightPx * 2);
	} catch {
		return undefined;
	}
	const image = renderImageRows(Buffer.from(png).toString("base64"), "image/png", width, {
		maxWidthCells: cols,
		maxHeightCells: rows,
	});
	const lines = frameImage(image, width);
	cache.set(key, lines);
	if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value ?? "");
	return lines;
}

/** beautiful-mermaid's text drawing as a plain code block, or undefined. */
function renderMermaidText(source: string, width: number): string[] | undefined {
	if (!engine) return undefined;
	let text: string;
	try {
		text = engine.text(source);
	} catch {
		return undefined;
	}
	const lines = text.replace(/\s+$/, "").split("\n");
	if (lines.some((line) => line.length > width)) return undefined;
	return ["```", ...lines, "```"];
}

/** Replace ```mermaid fences with an image, or text when no image can be shown. */
export function renderMermaidBlocks(markdown: string, width: number): string {
	if (!engine || !markdown.includes("mermaid")) return markdown;
	const lines = markdown.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const fence = FENCE.exec(line)?.[1];
		const end = fence ? lines.findIndex((l, j) => j > i && l.trim() === fence) : -1;
		const source = end < 0 ? "" : lines.slice(i + 1, end).join("\n");
		const rows = source.trim()
			? (renderMermaidImage(source, width) ?? renderMermaidText(source, width))
			: undefined;
		if (!rows) {
			out.push(line);
			continue;
		}
		out.push("", ...rows, "");
		i = end;
	}
	return out.join("\n");
}
