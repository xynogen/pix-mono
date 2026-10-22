import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ALL_LANGUAGES,
	grammarCacheDir,
	languageForFile,
	parseWithGrammar,
} from "@xynogen/pix-runtime/ast";
import { tempDir } from "@xynogen/pix-runtime/paths";
import registerAstGrep from "./astgrep.ts";

// ponytail: opt-in native integration; ordinary tests never download grammars.
// Run: PIX_AST_GRAMMARS_DIR=<npm-prefix-with-18-grammars> bun run test languages.integration.test.ts
const prefix = process.env.PIX_AST_GRAMMARS_DIR;
const cases = [
	["typescript", "ts", "const pixneedle: number = 123;"],
	["tsx", "tsx", "const pixneedle = <div value={123} />;"],
	["javascript", "js", "const pixneedle = 123;"],
	["jsx", "jsx", "const pixneedle = <div value={123} />;"],
	["css", "css", ".pixneedle { width: 123px; }", "width: 123px;", "width: 456px;"],
	["html", "html", '<div class="pixneedle">123</div>'],
	["python", "py", "pixneedle = 123"],
	["go", "go", "package main\nvar pixneedle = 123"],
	["rust", "rs", "const pixneedle: i32 = 123;"],
	["java", "java", "class Sample { int pixneedle = 123; }"],
	["c", "c", "int pixneedle = 123;"],
	["cpp", "cpp", "int pixneedle = 123;"],
	["csharp", "cs", "class Sample { int pixneedle = 123; }"],
	["ruby", "rb", "pixneedle = 123"],
	["php", "php", "<?php $pixneedle = 123;"],
	["swift", "swift", "let pixneedle = 123"],
	["kotlin", "kt", "val pixneedle = 123"],
	["scala", "scala", "val pixneedle = 123"],
	["lua", "lua", "local pixneedle = 123"],
	["elixir", "ex", "pixneedle = 123"],
	["json", "json", '{"pixneedle": 123}'],
	["yaml", "yaml", "pixneedle: 123"],
	["bash", "sh", "pixneedle=123"],
	["haskell", "hs", "pixneedle = 123"],
] as const;

interface Tool {
	name: string;
	execute(
		id: string,
		args: Record<string, unknown>,
	): Promise<{
		content: Array<{ text?: string }>;
		details?: unknown;
		isError?: boolean;
	}>;
}

const tools = new Map<string, Tool>();
let cwd: string;

describe.skipIf(!prefix)("all real AST grammars", () => {
	beforeAll(() => {
		cwd = mkdtempSync(join(tempDir(), "pix-ast-languages-"));
		mkdirSync(grammarCacheDir(), { recursive: true });
		symlinkSync(join(prefix!, "node_modules"), join(grammarCacheDir(), "node_modules"), "junction");
		const previous = process.cwd();
		try {
			process.chdir(cwd);
			registerAstGrep({
				on() {},
				registerTool(tool: Tool) {
					tools.set(tool.name, tool);
				},
			} as never);
		} finally {
			process.chdir(previous);
		}
	});

	afterAll(() => {
		rmSync(join(grammarCacheDir(), "node_modules"), { force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	test("the matrix covers every advertised language", () => {
		expect(cases.map(([lang]) => lang).sort()).toEqual([...ALL_LANGUAGES].sort());
	});

	for (const [lang, extension, source, pattern = "123", rewrite = "456"] of cases) {
		test(`${lang}: cache load, parse, discovery, search, preview and apply`, async () => {
			const file = `${lang}.${extension}`;
			expect(languageForFile(file)).toBe(lang);
			const parsed = await parseWithGrammar(lang, source);
			if (parsed.kind !== "ok") throw new Error(JSON.stringify(parsed));
			expect(parsed.kind).toBe("ok");
			expect(parsed.root.findAll({ rule: { kind: "ERROR" } })).toHaveLength(0);
			writeFileSync(join(cwd, file), source);
			const execute = async (name: string, args: Record<string, unknown>) => {
				const tool = tools.get(name);
				if (!tool) throw new Error(`Missing tool: ${name}`);
				const result = await tool.execute("integration", args);
				if (result.isError) throw new Error(JSON.stringify(result));
				return result;
			};
			const symbols = await execute("symbol_search", { query: "pixneedle", paths: [file] });
			expect(symbols.details).toMatchObject({ count: 1, scanned: 1 });
			const matcher = lang === "php" ? { context: "<?php 123;", selector: "integer" } : pattern;
			const search = await execute("ast_search", { pattern: matcher, paths: [file] });
			expect(search.details).toMatchObject({ matches: 1 });
			const preview = await execute("ast_replace", {
				pattern: matcher,
				rewrite,
				paths: [file],
			});
			expect(preview.details).toMatchObject({ applied: false, edits: 1 });
			expect(readFileSync(join(cwd, file), "utf8")).toBe(source);
			const applied = await execute("ast_replace", {
				pattern: matcher,
				rewrite,
				paths: [file],
				apply: true,
			});
			expect(applied.details).toMatchObject({ applied: true, edits: 1 });
			expect(readFileSync(join(cwd, file), "utf8")).toBe(source.replace(pattern, rewrite));
		});
	}
});
