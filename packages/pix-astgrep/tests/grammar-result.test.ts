import { expect, test } from "bun:test";
import { grammarErrorResult } from "../src/grammar-result.ts";

test("grammarErrorResult maps every non-ok outcome to a status and message", () => {
	const cases = [
		[
			{ kind: "needs-install", pkg: "@ast-grep/lang-go" },
			"needs-grammar",
			"go needs grammar @ast-grep/lang-go",
		],
		[{ kind: "declined", pkg: "@ast-grep/lang-go" }, "needs-grammar", "go grammar not installed"],
		[{ kind: "unsupported" }, "unsupported", 'Language "go" is not supported'],
		[{ kind: "error", message: "bad wasm" }, "error", "ast-grep error for go: bad wasm"],
		[{ kind: "ready" }, "error", "ast-grep could not parse go."],
	] as const;
	for (const [outcome, status, text] of cases) {
		const result = grammarErrorResult(outcome, "go", "astSearch");
		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ _type: "astSearch", outcome: status, lang: "go" });
		expect(result.content[0]?.text).toContain(text);
	}
});
