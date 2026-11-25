import { afterEach, expect, test } from "bun:test";
import { setMarkdownTransform, transformMarkdown } from "../src/markdown-transform.ts";

afterEach(() => setMarkdownTransform(undefined));

test("returns the source unchanged without a registered transform", () => {
	expect(transformMarkdown("::card[1]", 80)).toBe("::card[1]");
});

test("applies the registered transform with the width", () => {
	setMarkdownTransform((markdown, width) => `${markdown}@${width}`);
	expect(transformMarkdown("x", 42)).toBe("x@42");
});

test("keeps the source when the transform throws", () => {
	setMarkdownTransform(() => {
		throw new Error("boom");
	});
	expect(transformMarkdown("x", 10)).toBe("x");
});
