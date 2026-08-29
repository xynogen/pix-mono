/**
 * Smoke tests for pix-themes — verifies both bundled themes are present and valid.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const THEMES = [
	"pix-tokyo-night",
	"pix-one-dark",
	"pix-catppuccin-mocha",
	"pix-gruvbox-dark",
	"pix-dracula",
	"pix-nord",
	"pix-rose-pine",
] as const;

const THINKING_COLOR_KEYS = [
	["thinkingOff", "muted"],
	["thinkingMinimal", "dim"],
	["thinkingLow", "success"],
	["thinkingMedium", "accent"],
	["thinkingHigh", "warning"],
	["thinkingXhigh", "error"],
] as const;

const EXPRESSIVE_SYNTAX_KEYS = [
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxPunctuation",
] as const;

const SECONDARY_COLOR_KEYS = ["thinkingText", "mdQuote", "toolDiffContext"] as const;
const TERTIARY_COLOR_KEYS = ["mdLinkUrl", "mdQuoteBorder", "mdHr", "syntaxPunctuation"] as const;

function readTheme(name: (typeof THEMES)[number]) {
	const themeFile = resolve(__dirname, `../themes/${name}.json`);
	try {
		return JSON.parse(readFileSync(themeFile, "utf8"));
	} catch (error) {
		throw new Error(`Invalid theme JSON: ${name}`, { cause: error });
	}
}

function luminance(hex: string): number {
	const channels =
		hex.match(/[\da-f]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
	return channels.reduce(
		(sum, value, index) =>
			sum +
			(value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
				[0.2126, 0.7152, 0.0722][index]!,
		0,
	);
}

describe("pix-themes", () => {
	it("theme directory exists", () => {
		const themesDir = resolve(__dirname, "../themes");
		expect(existsSync(themesDir)).toBe(true);
	});

	for (const name of THEMES) {
		it(`contains ${name} theme file`, () => {
			const themeFile = resolve(__dirname, `../themes/${name}.json`);
			expect(existsSync(themeFile)).toBe(true);
		});

		it(`${name} is valid JSON with the expected name`, () => {
			const theme = readTheme(name);
			expect(theme.name).toBe(name);
		});

		it(`${name} maps thinking levels to the shared semantic ramp`, () => {
			const theme = readTheme(name);
			for (const [thinkingKey, semanticKey] of THINKING_COLOR_KEYS) {
				expect(theme.colors[thinkingKey]).toBe(theme.colors[semanticKey]);
			}
		});

		it(`${name} keeps common syntax roles visually distinct`, () => {
			const theme = readTheme(name);
			const resolved = EXPRESSIVE_SYNTAX_KEYS.map((key) => {
				const value = theme.colors[key];
				return theme.vars[value] ?? value;
			});
			expect(new Set(resolved).size).toBe(EXPRESSIVE_SYNTAX_KEYS.length);
		});

		it(`${name} maps secondary and tertiary content by information priority`, () => {
			const theme = readTheme(name);
			for (const key of SECONDARY_COLOR_KEYS) expect(theme.colors[key]).toBe("dim");
			for (const key of TERTIARY_COLOR_KEYS) expect(theme.colors[key]).toBe("muted");
		});

		it(`${name} keeps dim brighter than muted`, () => {
			const theme = readTheme(name);
			expect(luminance(theme.vars.dim)).toBeGreaterThan(luminance(theme.vars.muted));
		});

		it(`${name} leaves tool surfaces on the terminal background`, () => {
			const theme = readTheme(name);
			for (const key of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"]) {
				expect(theme.colors[key]).toBe("");
			}
		});
	}
});
