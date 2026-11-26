import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	getPngDimensions,
	Markdown,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "@earendil-works/pi-tui";
import { renderDirectives } from "../src/directives.js";
import { renderImageRows } from "../src/image.js";

// 1×1 transparent PNG.
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);
const dir = mkdtempSync(join(tmpdir(), "pix-image-"));
const file = join(dir, "dot.png");
writeFileSync(file, PNG);

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const identity = (text: string) => text;
// SAFETY: every MarkdownTheme member is a string styler; identity keeps text plain.
const theme = new Proxy({}, { get: () => identity }) as ConstructorParameters<typeof Markdown>[3];

function render(markdown: string, width = 40): readonly string[] {
	return new Markdown(renderDirectives(markdown, width), 0, 0, theme).render(width);
}

afterEach(() => resetCapabilitiesCache());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("::image", () => {
	it("emits a Kitty image sequence and reserves its rows", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const lines = render(`a\n\n::image[dot]{src="${pathToFileURL(file).href}" width=4}\n\nb`);
		const image = lines.findIndex((line) => line.includes("\x1b_G"));
		expect(image).toBeGreaterThan(0);
		expect(lines[0]?.trimEnd()).toBe("a");
		expect(lines.at(-1)?.trimEnd()).toBe("b");
	});

	it("falls back to text when the terminal has no image protocol", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const text = render(`::image[dot]{src="${file}"}`).join("\n").replace(ANSI_RE, "");
		expect(text).toContain("[Image: dot.png [image/png] 1x1]");
	});

	it("explains a remote, missing or unsupported source instead of loading it", () => {
		const text = (src: string) =>
			render(`::image[x]{src="${src}"}`, 200).join("").replace(ANSI_RE, "").trim();
		expect(text("https://example.com/a.png")).toBe("(image: x: only file:// or absolute paths)");
		expect(text(join(dir, "missing.png"))).toBe("(image: x: not found)");
		expect(text(join(dir, "a.txt"))).toBe("(image: x: unsupported type)");
		// A Windows path keeps its backslashes through the attribute parser.
		const win = render('::image[]{src="C:\\a\\b.png"}', 200).join("").replace(ANSI_RE, "");
		expect(win).toContain("C:\\a\\b.png");
	});

	it("stays literal inside a code fence or without src", () => {
		const md = '```\n::image[x]{src="/a.png"}\n```\n::image[x]';
		expect(renderDirectives(md, 40)).toBe(md);
	});

	it("downscales a large image to the pixels its cells show", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		const req = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const photon = req("@silvia-odwyer/photon-node");
		const big = new photon.PhotonImage(new Uint8Array(4000 * 2000 * 4).fill(255), 4000, 2000);
		const data = Buffer.from(big.get_bytes()).toString("base64");
		big.free();
		const payload = (rows: string[]) =>
			[...rows.join("").matchAll(/\x1b_G[^;]*;([^\x1b]*)\x1b\\/g)].map((m) => m[1]).join("");
		// 50 columns at 10 px: the 4000 px source shrinks to 500 px wide, aspect kept.
		const shown = payload(renderImageRows(data, "image/png", 80, { maxWidthCells: 50 }));
		expect(getPngDimensions(shown)).toEqual({ widthPx: 500, heightPx: 250 });
		// Already within its cells: passed through untouched.
		const small = payload(
			renderImageRows(PNG.toString("base64"), "image/png", 80, { maxWidthCells: 4 }),
		);
		expect(small).toBe(PNG.toString("base64"));
	});
});
