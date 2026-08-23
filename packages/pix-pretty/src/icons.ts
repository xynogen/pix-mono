import { basename, extname } from "node:path";
import type { FgTheme } from "./types.js";

const ICONS_MODE = (process.env.PRETTY_ICONS ?? "nerd").toLowerCase();
const USE_ICONS = ICONS_MODE !== "none" && ICONS_MODE !== "off";

interface IconSpec {
	glyph: string;
	color: string;
}

const FILE = "\uf15b";
const EXT_ICON: Record<string, IconSpec> = {
	ts: { glyph: "\ue628", color: "syntaxType" },
	tsx: { glyph: "\ue7ba", color: "syntaxType" },
	js: { glyph: "\ue74e", color: "syntaxNumber" },
	jsx: { glyph: "\ue7ba", color: "syntaxVariable" },
	mjs: { glyph: "\ue74e", color: "syntaxNumber" },
	cjs: { glyph: "\ue74e", color: "syntaxNumber" },
	py: { glyph: "\ue73c", color: "syntaxFunction" },
	rs: { glyph: "\ue7a8", color: "syntaxType" },
	go: { glyph: "\ue724", color: "syntaxVariable" },
	java: { glyph: "\ue738", color: "syntaxKeyword" },
	swift: { glyph: "\ue755", color: "syntaxNumber" },
	rb: { glyph: "\ue739", color: "syntaxKeyword" },
	kt: { glyph: "\ue634", color: "syntaxType" },
	c: { glyph: "\ue61e", color: "syntaxFunction" },
	cpp: { glyph: "\ue61d", color: "syntaxFunction" },
	h: { glyph: "\ue61e", color: "muted" },
	hpp: { glyph: "\ue61d", color: "muted" },
	cs: { glyph: "\ue648", color: "syntaxType" },
	html: { glyph: "\ue736", color: "syntaxKeyword" },
	css: { glyph: "\ue749", color: "syntaxFunction" },
	scss: { glyph: "\ue749", color: "syntaxType" },
	less: { glyph: "\ue749", color: "syntaxFunction" },
	vue: { glyph: "\ue6a0", color: "syntaxString" },
	svelte: { glyph: "\ue697", color: "syntaxKeyword" },
	json: { glyph: "\ue60b", color: "syntaxNumber" },
	jsonc: { glyph: "\ue60b", color: "syntaxNumber" },
	yaml: { glyph: "\ue6a8", color: "syntaxType" },
	yml: { glyph: "\ue6a8", color: "syntaxType" },
	toml: { glyph: "\ue6b2", color: "syntaxType" },
	xml: { glyph: "\ue619", color: "syntaxKeyword" },
	sql: { glyph: "\ue706", color: "text" },
	md: { glyph: "\ue73e", color: "accent" },
	mdx: { glyph: "\ue73e", color: "accent" },
	sh: { glyph: "\ue795", color: "syntaxString" },
	bash: { glyph: "\ue795", color: "syntaxString" },
	zsh: { glyph: "\ue795", color: "syntaxString" },
	fish: { glyph: "\ue795", color: "syntaxString" },
	lua: { glyph: "\ue620", color: "syntaxFunction" },
	php: { glyph: "\ue73d", color: "syntaxType" },
	dart: { glyph: "\ue798", color: "syntaxFunction" },
	png: { glyph: "\uf1c5", color: "syntaxType" },
	jpg: { glyph: "\uf1c5", color: "syntaxType" },
	jpeg: { glyph: "\uf1c5", color: "syntaxType" },
	gif: { glyph: "\uf1c5", color: "syntaxType" },
	svg: { glyph: "\uf1c5", color: "syntaxNumber" },
	webp: { glyph: "\uf1c5", color: "syntaxType" },
	ico: { glyph: "\uf1c5", color: "syntaxType" },
	lock: { glyph: "\uf023", color: "muted" },
	env: { glyph: "\ue615", color: "syntaxNumber" },
	graphql: { glyph: "\ue662", color: "syntaxType" },
	dockerfile: { glyph: "\ue7b0", color: "syntaxFunction" },
};

const NAME_ICON: Record<string, IconSpec> = {
	"package.json": { glyph: "\ue71e", color: "syntaxString" },
	"package-lock.json": { glyph: "\ue71e", color: "muted" },
	"tsconfig.json": { glyph: "\ue628", color: "syntaxType" },
	"biome.json": { glyph: "\ue615", color: "syntaxFunction" },
	".gitignore": { glyph: "\ue702", color: "syntaxType" },
	".git": { glyph: "\ue702", color: "syntaxType" },
	".env": { glyph: "\ue615", color: "syntaxNumber" },
	".envrc": { glyph: "\ue615", color: "syntaxNumber" },
	dockerfile: { glyph: "\ue7b0", color: "syntaxFunction" },
	makefile: { glyph: "\ue615", color: "muted" },
	gnumakefile: { glyph: "\ue615", color: "muted" },
	"readme.md": { glyph: "\ue73e", color: "accent" },
	license: { glyph: "\ue60a", color: "text" },
	"cargo.toml": { glyph: "\ue7a8", color: "syntaxType" },
	"go.mod": { glyph: "\ue724", color: "syntaxVariable" },
	"pyproject.toml": { glyph: "\ue73c", color: "syntaxFunction" },
};

function paint(spec: IconSpec, theme?: FgTheme): string {
	return theme ? theme.fg(spec.color, spec.glyph) : spec.glyph;
}

/** File icon whose color is derived from the active Pi theme when available. */
export function fileIcon(fp: string, theme?: FgTheme): string {
	if (!USE_ICONS) return "";
	const base = basename(fp).toLowerCase();
	const ext = extname(fp).slice(1).toLowerCase();
	const spec = NAME_ICON[base] ?? EXT_ICON[ext] ?? { glyph: FILE, color: "muted" };
	return `${paint(spec, theme)} `;
}

/** Directory icon whose color is derived from the active Pi theme. */
export function dirIcon(theme?: FgTheme): string {
	return USE_ICONS ? `${paint({ glyph: "\ue5ff", color: "accent" }, theme)} ` : "";
}

/**
 * Color a filename by its type, reusing the same per-extension palette the
 * icons use (so name and icon share a hue). Unknown types fall back to the
 * theme's default text color. Pure passthrough when no theme is supplied.
 */
export function fileColor(fp: string, name: string, theme?: FgTheme): string {
	if (!theme) return name;
	const base = basename(fp).toLowerCase();
	const ext = extname(fp).slice(1).toLowerCase();
	const spec = NAME_ICON[base] ?? EXT_ICON[ext];
	return theme.fg(spec?.color ?? "text", name);
}
