/**
 * grammars.test.ts — the multi-language routing and consent gate.
 *
 * These do NOT install anything. They check that: the bundled six parse in
 * process; a non-bundled language reports `needs-install` with the right
 * package; a declined language is remembered; and an unknown alias is
 * `unsupported`. The real install path is exercised only when the grammar is
 * already present, which we do not require here.
 */

import { describe, expect, test } from "bun:test";
import { ALL_LANGUAGES, isBundled, languageForFile } from "./engine.ts";
import { packageForLanguage, parseWithGrammar } from "./grammars.ts";

describe("language coverage", () => {
	test("advertises far more than the six bundled grammars", () => {
		expect(ALL_LANGUAGES.length).toBeGreaterThanOrEqual(20);
		expect(ALL_LANGUAGES).toContain("python");
		expect(ALL_LANGUAGES).toContain("go");
		expect(ALL_LANGUAGES).toContain("rust");
	});

	test("only six languages are bundled in-process", () => {
		const bundled = ALL_LANGUAGES.filter((l) => isBundled(l));
		expect(bundled.sort()).toEqual(["css", "html", "javascript", "jsx", "tsx", "typescript"]);
	});

	test("maps file extensions across languages", () => {
		expect(languageForFile("a.py")).toBe("python");
		expect(languageForFile("a.go")).toBe("go");
		expect(languageForFile("a.rs")).toBe("rust");
		expect(languageForFile("a.ts")).toBe("typescript");
	});

	test("each non-bundled language names a @ast-grep/lang-* package", () => {
		for (const lang of ALL_LANGUAGES) {
			if (isBundled(lang)) continue;
			expect(packageForLanguage(lang)).toMatch(/^@ast-grep\/lang-/);
		}
	});
});

describe("parseWithGrammar", () => {
	for (const [lang, source] of [
		["typescript", "const x: number = 1;"],
		["tsx", "const x = <div />;"],
		["javascript", "const x = 1;"],
		["jsx", "const x = <div />;"],
		["css", "div { color: red; }"],
		["html", "<div>hello</div>"],
	] as const) {
		test(`${lang} parses without requesting installation`, async () => {
			const out = await parseWithGrammar(lang, source, async () => {
				throw new Error("Bundled grammars must not request installation");
			});
			expect(out.kind).toBe("ok");
		});
	}

	for (const lang of ["cobol", "hcl", "nix", "solidity"]) {
		test(`${lang} does not offer an unavailable grammar package`, async () => {
			expect(await parseWithGrammar(lang, "")).toEqual({ kind: "unsupported" });
			expect(packageForLanguage(lang)).toBeUndefined();
		});
	}

	for (const lang of ALL_LANGUAGES.filter((lang) => !isBundled(lang))) {
		test(`${lang}: headless calls defer consent and rejection is remembered`, async () => {
			const out = await parseWithGrammar(lang, "");
			expect(["needs-install", "ok"]).toContain(out.kind);
			if (out.kind === "ok") return;
			expect(out).toEqual({ kind: "needs-install", pkg: packageForLanguage(lang)! });
			const prompts: string[] = [];
			const consent = async (pkg: string) => {
				prompts.push(pkg);
				return false;
			};
			const retried = await parseWithGrammar(lang, "", consent);
			expect(retried).toEqual({ kind: "declined", pkg: packageForLanguage(lang)! });
			expect(await parseWithGrammar(lang, "", consent)).toEqual(retried);
			expect(prompts).toEqual([packageForLanguage(lang)!]);
		});
	}
});
