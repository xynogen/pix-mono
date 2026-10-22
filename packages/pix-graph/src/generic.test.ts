import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWithGrammar } from "@xynogen/pix-runtime/ast";
import { extractGeneric, type ParseFn } from "./generic.ts";

// The generic extractor only reads tree-sitter conventions (name/body fields, *call* nodes), so the
// bundled TypeScript grammar stands in for a downloaded one; tests stay offline.
const parse: ParseFn = (lang, source) =>
	lang === "missing"
		? Promise.resolve({ kind: "declined", pkg: "@ast-grep/lang-missing" })
		: parseWithGrammar("typescript", source);

test("generic extractor links a call only to a name defined in exactly one other file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pix-graph-generic-"));
	const files = {
		"a.x": "function main() { helper(); get(); }\nclass Server { start() {} }",
		"b.x": "function helper() { return 1; }\nfunction get() {}",
		"c.x": "function get() {}",
		"d.y": "function lost() {}",
	};
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	const r = await extractGeneric(
		Object.keys(files).map((rel) => ({
			file: join(dir, rel),
			rel,
			lang: rel.endsWith(".y") ? "missing" : "x",
		})),
		undefined,
		undefined,
		undefined,
		parse,
	);
	expect(r.languages).toEqual({ x: 3 });
	expect(r.skipped).toEqual([
		"missing: 1 file(s) skipped (grammar @ast-grep/lang-missing declined)",
	]);
	expect(r.nodes.map((n) => n.label).sort()).toEqual(
		["Server", "a.x", "b.x", "c.x", "get()", "get()", "helper()", "main()", "start()"].sort(),
	);
	// `get` is defined twice, so only the unambiguous helper() call becomes an edge.
	expect(
		r.links.filter((l) => l.relation === "calls").map((l) => `${l.source}->${l.target}`),
	).toEqual(["a_x_main->b_x_helper"]);
});
