/**
 * Quality bar for the bundled skills, following Anthropic's skill-authoring
 * guide: valid name, a description that says what the skill does AND when to
 * use it, on-demand loading, and a bounded body.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extractDescription, extractName } from "./index.ts";

const dir = new URL("../skills/", import.meta.url);
// Flat `name.md` or bundle `name/SKILL.md` — the two layouts the loader accepts.
const skills = readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
	const file = entry.isDirectory() ? `${entry.name}/SKILL.md` : entry.name;
	const url = new URL(file, dir);
	if (!file.endsWith(".md") || !existsSync(url)) return [];
	const name = entry.isDirectory() ? entry.name : entry.name.slice(0, -3);
	return [{ file, name, text: readFileSync(url, "utf8") }];
});

describe("bundled skills", () => {
	it("exist", () => {
		expect(skills.length).toBeGreaterThan(0);
	});

	for (const { file, name: expected, text } of skills) {
		describe(file, () => {
			it("has a valid name that matches the file", () => {
				const name = extractName(text);
				expect(name).toMatch(/^[a-z0-9-]{1,64}$/);
				expect(name).toBe(expected);
			});

			it("describes what it does and when to use it", () => {
				const description = extractDescription(text) ?? "";
				expect(description.length).toBeGreaterThanOrEqual(80);
				expect(description.length).toBeLessThanOrEqual(1024);
				expect(description).toMatch(/\b(use|load) (when|whenever|before|for|only)\b/i);
			});

			it("loads on demand and stays under 500 lines", () => {
				expect(text).toMatch(/^disable-model-invocation: true$/m);
				expect(text.split("\n").length).toBeLessThanOrEqual(500);
			});
		});
	}
});
