import { expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as engine from "./engine.ts";

const registrations: Array<Record<string, unknown>> = [];
mock.module("./engine.ts", () => ({
	...engine,
	loadEngine: async () => ({
		registerDynamicLanguage(languages: Record<string, unknown>) {
			registrations.push(languages);
		},
	}),
}));
const { ensureLanguage, grammarCacheDir } = await import("./grammars.ts");

test("cached grammars register together once; a later language explicitly requires restart", async () => {
	const cacheGrammar = (lang: string) => {
		const dir = join(grammarCacheDir(), "node_modules", "@ast-grep", `lang-${lang}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "index.js" }));
		writeFileSync(
			join(dir, "index.js"),
			`module.exports = { extensions: [${JSON.stringify(lang)}] };`,
		);
	};
	cacheGrammar("python");
	cacheGrammar("go");
	expect(await Promise.all([ensureLanguage("python"), ensureLanguage("go")])).toEqual([
		{ kind: "ready" },
		{ kind: "ready" },
	]);
	expect(registrations).toHaveLength(1);
	expect(Object.keys(registrations[0]!).sort()).toEqual(["go", "python"]);
	cacheGrammar("rust");
	expect(await ensureLanguage("rust")).toMatchObject({
		kind: "error",
		message: expect.stringContaining("Restart the agent"),
	});
	expect(await ensureLanguage("python")).toEqual({ kind: "ready" });
	expect(registrations).toHaveLength(1);
});
