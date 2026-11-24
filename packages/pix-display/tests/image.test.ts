import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Markdown, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { renderDirectives } from "../src/directives.js";

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
});
