/**
 * Fixed eval tasks over a small TypeScript fixture. Each task copies the
 * fixture into a fresh temp dir, applies its own overrides, runs Pi once, then
 * checks the files (via the fixture's own `bun test`) or the final answer.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CheckContext {
	dir: string;
	finalText: string;
	/** Runs `bun test` in the fixture dir; true when every test passes. */
	testsPass: () => Promise<boolean>;
}

export interface EvalTask {
	id: string;
	kind: "read" | "search" | "edit" | "multi-edit" | "fix-test";
	prompt: string;
	/** Later user messages in the same session, sent after `prompt` settles. */
	followUps?: string[];
	/** Extra or replaced fixture files for this task only. */
	files?: Record<string, string>;
	check: (c: CheckContext) => Promise<boolean> | boolean;
}

const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");

/** 400 catalog rows: big enough that a whole-file read costs real tokens. */
const catalog = `export interface Item {\n\tid: number;\n\tsku: string;\n\tprice: number;\n}\n\nexport const ITEMS: Item[] = [\n${Array.from(
	{ length: 400 },
	(_, i) =>
		`\t{ id: ${i + 1}, sku: "SKU-${String(i + 1).padStart(4, "0")}", price: ${(i * 37) % 997} },`,
).join("\n")}\n];\n`;

export const FIXTURE: Record<string, string> = {
	"package.json": `{ "name": "eval-fixture", "type": "module", "private": true }\n`,
	"README.md": "# eval-fixture\n\nThe server listens on port 3000 by default.\n",
	"src/config.ts": `export const DEFAULT_PORT = 3000;\nexport const RETRY_LIMIT = 4;\nexport const API_PREFIX = "/api/v2";\n`,
	"src/server.ts": `import { API_PREFIX, DEFAULT_PORT } from "./config.ts";\n\nexport function describeServer(port = DEFAULT_PORT): string {\n\treturn \`listening on \${port} at \${API_PREFIX}\`;\n}\n`,
	"src/retry.ts": `import { RETRY_LIMIT } from "./config.ts";\n\nexport async function retry<T>(fn: () => Promise<T>, limit = RETRY_LIMIT): Promise<T> {\n\tlet last: unknown;\n\tfor (let i = 0; i < limit; i++) {\n\t\ttry {\n\t\t\treturn await fn();\n\t\t} catch (e) {\n\t\t\tlast = e;\n\t\t}\n\t}\n\tthrow last;\n}\n`,
	"src/math.ts": `export function add(a: number, b: number): number {\n\treturn a + b;\n}\n\nexport function sub(a: number, b: number): number {\n\treturn a - b;\n}\n\n/** Clamp n into [lo, hi]. */\nexport function clamp(n: number, lo: number, hi: number): number {\n\treturn Math.min(hi, Math.max(lo, n));\n}\n`,
	"src/math.test.ts": `import { expect, test } from "bun:test";\nimport { add, clamp, sub } from "./math.ts";\n\ntest("add/sub", () => {\n\texpect(add(2, 3)).toBe(5);\n\texpect(sub(2, 3)).toBe(-1);\n});\n\ntest("clamp", () => {\n\texpect(clamp(5, 0, 10)).toBe(5);\n\texpect(clamp(-1, 0, 10)).toBe(0);\n\texpect(clamp(11, 0, 10)).toBe(10);\n});\n`,
	"src/strings.ts": `export function capitalize(s: string): string {\n\treturn s.charAt(0).toUpperCase() + s.slice(1);\n}\n\nexport function slugify(s: string): string {\n\treturn s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n}\n\nexport function truncate(s: string, n: number): string {\n\treturn s.length <= n ? s : \`\${s.slice(0, n - 1)}…\`;\n}\n\nexport function title(s: string): string {\n\treturn s.split(" ").map(capitalize).join(" ");\n}\n`,
	"src/strings.test.ts": `import { expect, test } from "bun:test";\nimport { capitalize, slugify, title, truncate } from "./strings.ts";\n\ntest("strings", () => {\n\texpect(capitalize("abc")).toBe("Abc");\n\texpect(slugify(" Hello World! ")).toBe("hello-world");\n\texpect(truncate("abcdef", 4)).toBe("abc…");\n\texpect(title("a b")).toBe("A B");\n});\n`,
	"src/duration.ts": `const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };\n\n/** Parse "1h30m", "45s", "250ms" into milliseconds. */\nexport function parseDuration(text: string): number {\n\tlet total = 0;\n\tfor (const [, n, unit] of text.matchAll(/(\\d+)(ms|s|m|h)/g)) {\n\t\ttotal += Number(n) * (UNITS[unit as string] ?? 0);\n\t}\n\treturn total;\n}\n`,
	"src/duration.test.ts": `import { expect, test } from "bun:test";\nimport { parseDuration } from "./duration.ts";\n\ntest("parseDuration", () => {\n\texpect(parseDuration("45s")).toBe(45_000);\n\texpect(parseDuration("1h30m")).toBe(5_400_000);\n\texpect(parseDuration("250ms")).toBe(250);\n});\n`,
	"src/catalog.ts": catalog,
};

/** 2000 ledger rows for the long session: every lookup lands in its own 100-line window. */
const LEDGER_ROWS = 2000;
const code = (id: number) => `L-${String(id).padStart(5, "0")}`;
const amountOf = (id: number) => (id * 7919) % 99991;
const ledger = `export const LEDGER = [\n${Array.from(
	{ length: LEDGER_ROWS },
	(_, i) =>
		`\t{ code: "${code(i + 1)}", amount: ${amountOf(i + 1)}, note: "entry ${i + 1} of the ledger" },`,
).join("\n")}\n];\n`;
/** Row ids 50, 170, 290…: 16 lookups, each needing a different window. */
const LONG_IDS = Array.from({ length: 16 }, (_, i) => 50 + i * 120);
const lookup = (id: number) =>
	`Read src/ledger.ts with the read tool (limit 100) around ${code(id)} and tell me its amount. Do not reuse earlier reads.`;

export const TASKS: EvalTask[] = [
	{
		id: "read-config",
		kind: "read",
		prompt: "What is RETRY_LIMIT in this project? Answer with only the number.",
		check: ({ finalText }) => /^\D*4\D*$/.test(finalText),
	},
	{
		id: "search-def",
		kind: "search",
		prompt:
			"Which file defines the function parseDuration? Answer with only its path relative to the project root.",
		check: ({ finalText }) => finalText.includes("src/duration.ts"),
	},
	{
		id: "search-importers",
		kind: "search",
		prompt: "How many files under src/ import from ./config.ts? Answer with only the number.",
		check: ({ finalText }) => /^\D*2\D*$/.test(finalText),
	},
	{
		id: "read-catalog-row",
		kind: "read",
		prompt: "In src/catalog.ts, what is the price of SKU-0317? Answer with only the number.",
		check: ({ finalText }) => new RegExp(`^\\D*${(316 * 37) % 997}\\D*$`).test(finalText),
	},
	{
		id: "fix-clamp",
		kind: "fix-test",
		prompt:
			"The tests in src/math.test.ts fail. Fix the bug in src/math.ts. Do not change the tests.",
		files: {
			"src/math.ts":
				FIXTURE["src/math.ts"]?.replace(
					"Math.min(hi, Math.max(lo, n))",
					"Math.min(lo, Math.max(hi, n))",
				) ?? "",
		},
		check: async ({ dir, testsPass }) =>
			read(dir, "src/math.test.ts") === FIXTURE["src/math.test.ts"] && (await testsPass()),
	},
	{
		id: "fix-duration",
		kind: "fix-test",
		prompt:
			'parseDuration must also accept a bare number as seconds ("90" → 90000). Add a test for it in src/duration.test.ts and make it pass.',
		check: async ({ dir, testsPass }) =>
			/"90"/.test(read(dir, "src/duration.test.ts")) && (await testsPass()),
	},
	{
		id: "edit-port",
		kind: "multi-edit",
		prompt: "Change the default port from 3000 to 8080 everywhere it is defined or documented.",
		check: ({ dir }) =>
			/DEFAULT_PORT = 8080/.test(read(dir, "src/config.ts")) &&
			/8080/.test(read(dir, "README.md")) &&
			!/3000/.test(read(dir, "README.md")),
	},
	{
		id: "rename-capitalize",
		kind: "multi-edit",
		prompt:
			"Rename the function capitalize to capitalizeFirst in src/strings.ts and update every use, tests included.",
		check: async ({ dir, testsPass }) =>
			!/\bcapitalize\b/.test(read(dir, "src/strings.ts") + read(dir, "src/strings.test.ts")) &&
			(await testsPass()),
	},
	{
		id: "chained-jsdoc",
		kind: "edit",
		prompt:
			"Add a one-line JSDoc comment above each exported function in src/strings.ts. Make one edit call per function.",
		check: async ({ dir, testsPass }) =>
			(read(dir, "src/strings.ts").match(/\/\*\*/g) ?? []).length >= 4 && (await testsPass()),
	},
	{
		id: "edit-catalog-row",
		kind: "edit",
		prompt: "In src/catalog.ts set the price of SKU-0350 to 1234. Change nothing else.",
		check: ({ dir }) => {
			const now = read(dir, "src/catalog.ts");
			const want = FIXTURE["src/catalog.ts"]?.replace(
				/(sku: "SKU-0350", price: )\d+/,
				(_, head: string) => `${head}1234`,
			);
			return now === want;
		},
	},
	{
		id: "add-mul",
		kind: "edit",
		prompt: "Add an exported mul(a, b) function to src/math.ts with a test in src/math.test.ts.",
		check: async ({ dir, testsPass }) =>
			/export function mul/.test(read(dir, "src/math.ts")) &&
			/mul\(/.test(read(dir, "src/math.test.ts")) &&
			(await testsPass()),
	},
	{
		// P1: crosses the compaction threshold with more than maskKeep large reads, so older ones get masked.
		id: "long-session",
		kind: "read",
		files: { "src/ledger.ts": ledger },
		prompt: lookup(LONG_IDS[0] ?? 50),
		followUps: [
			...LONG_IDS.slice(1).map(lookup),
			"List every code and amount you reported in this session, one `L-NNNNN: amount` per line.",
		],
		check: ({ finalText }) =>
			LONG_IDS.every((id) => new RegExp(`${code(id)}\\D{1,4}${amountOf(id)}\\b`).test(finalText)),
	},
];
