import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { makeRenderCtx } from "@xynogen/pix-pretty/test-utils";
import { tempDir } from "@xynogen/pix-runtime/paths";
import type { TSchema } from "typebox";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import registerEnv, { secretTarget } from "./extension.ts";
import {
	allRefsIn,
	collectRefs,
	collectUnsupported,
	describeRegistry,
	editEnvText,
	envPath,
	parseEnv,
	refsIn,
	resolveInput,
	resolveString,
	shellPrelude,
	shellQuote,
	unsupportedRefs,
} from "./lib.ts";

// Literal dotenv braced ref syntax, assembled from char codes so no `${...}`
// placeholder appears in source (it is intentional test data, not a mistake).
const L = String.fromCharCode(36, 123); // "${"
const R = String.fromCharCode(125); // "}"
const braced = (k: string) => L + k + R;

type EnvReadTool = {
	parameters: TSchema;
	execute: (
		id: string,
		params: {
			action: "info" | "read" | "add" | "edit";
			path?: string;
			names?: string[];
			name?: string;
			value?: string | number | boolean;
		},
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: unknown;
		isError?: boolean;
	}>;
	renderResult: (
		result: { content: Array<{ type: string; text: string }>; details?: unknown },
		options: { isPartial: boolean },
		theme: { fg: (color: string, text: string) => string },
		ctx: { isError: boolean },
	) => { render: (width: number) => string[] };
};

function captureEnvRead(): EnvReadTool {
	let tool: EnvReadTool | undefined;
	registerEnv({
		events: createEventBus(),
		on() {},
		registerTool(definition: EnvReadTool & { name: string }) {
			if (definition.name === "read_env") tool = definition;
		},
	} as unknown as ExtensionAPI);
	if (!tool) throw new Error("read_env not registered");
	return tool;
}

test("schema enforces action-specific fields through the host validator", () => {
	const tool = {
		name: "read_env",
		description: "Environment",
		parameters: captureEnvRead().parameters,
	};
	const validate = (args: ToolCall["arguments"]) =>
		validateToolArguments(tool, { type: "toolCall", id: "1", name: tool.name, arguments: args });
	const valid: ToolCall["arguments"][] = [
		{ action: "info" },
		{ action: "read", names: ["APP_PORT"] },
		{ action: "add", path: ".env.examples", name: "APP_PORT", value: 8080 },
		{ action: "edit", path: ".env", name: "ENABLED", value: false },
	];
	for (const args of valid) expect(validate(args)).toEqual(args);
	for (const action of ["add", "edit"]) {
		const args: ToolCall["arguments"] = { action, path: ".env", name: "APP_PORT", value: 8080 };
		for (const field of ["path", "name", "value"]) {
			const incomplete = { ...args };
			delete incomplete[field];
			expect(() => validate(incomplete)).toThrow();
		}
		expect(() => validate({ ...args, path: "" })).toThrow();
	}
	expect(() => validate({ action: "read" })).toThrow();
	expect(() => validate({ action: "read", names: [] })).toThrow();
	expect(() => validate({ action: "unknown" })).toThrow();
});

describe("read_env tool", () => {
	let cwd: string;
	let oldFiles: string | undefined;

	beforeEach(() => {
		cwd = mkdtempSync(join(tempDir(), "pix-env-"));
		writeFileSync(join(cwd, ".env"), "PORT=3000\nHOST=api.example.com\nTOKEN=secret-value\n");
		oldFiles = process.env.PIX_ENV_FILES;
		delete process.env.PIX_ENV_FILES;
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		if (oldFiles === undefined) delete process.env.PIX_ENV_FILES;
		else process.env.PIX_ENV_FILES = oldFiles;
	});

	test("info returns names and shapes without approval, values, or a reason", async () => {
		const tool = captureEnvRead();
		const result = await tool.execute("1", { action: "info" }, undefined, undefined, {
			cwd,
			hasUI: false,
			ui: {},
		});
		expect(result.content[0]?.text).toBe("HOST = string\nPORT = int\nTOKEN = string");
		expect(result.content[0]?.text).not.toContain("secret-value");
	});

	test("info honors an explicit path override", async () => {
		const tool = captureEnvRead();
		const alt = join(cwd, ".env.examples");
		writeFileSync(alt, "ALPHA=1\nBETA=two\n");
		const result = await tool.execute(
			"1",
			{ action: "info", path: ".env.examples" },
			undefined,
			undefined,
			{
				cwd,
				hasUI: false,
				ui: {},
			},
		);
		expect(result.content[0]?.text).toBe("ALPHA = int\nBETA = string");
	});

	test.each([
		"notes.txt",
		".env.",
		".env..local",
		".env.examples/notes.txt",
		"",
		".env\0",
	])("rejects invalid env path %j", async (path) => {
		const result = await captureEnvRead().execute(
			"1",
			{ action: "info", path },
			undefined,
			undefined,
			{ cwd, hasUI: false },
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^read_env failed: .+/);
	});

	test("missing explicit files fail visibly and directories still load defaults", async () => {
		const tool = captureEnvRead();
		const missing = await tool.execute(
			"1",
			{ action: "info", path: ".env.missing" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(missing.isError).toBe(true);
		const directory = await tool.execute("2", { action: "info", path: cwd }, undefined, undefined, {
			cwd,
		});
		expect(directory.content[0]?.text).toBe("HOST = string\nPORT = int\nTOKEN = string");
	});

	test.each([
		"add",
		"edit",
	] as const)("%s rejects a missing path without modifying .env", async (action) => {
		const before = readFileSync(join(cwd, ".env"), "utf-8");
		const result = await captureEnvRead().execute(
			"1",
			{ action, name: "APP_PORT", value: 8080 },
			undefined,
			undefined,
			{ cwd, hasUI: true, ui: approvalUi() },
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe("read_env failed: path is required for add/edit");
		expect(readFileSync(join(cwd, ".env"), "utf-8")).toBe(before);
	});

	test.each([
		"add",
		"edit",
	] as const)("%s requires approval and leaves the file unchanged without UI", async (action) => {
		const before = readFileSync(join(cwd, ".env"), "utf-8");
		const result = await captureEnvRead().execute(
			"1",
			{ action, path: ".env", name: action === "add" ? "APP_PORT" : "PORT", value: 8080 },
			undefined,
			undefined,
			{ cwd, hasUI: false },
		);
		expect(result.isError).toBe(true);
		expect(readFileSync(join(cwd, ".env"), "utf-8")).toBe(before);
	});

	test.each([
		"add",
		"edit",
	] as const)("%s saves only after approval without revealing values", async (action) => {
		const tool = captureEnvRead();
		const result = await tool.execute(
			"1",
			{ action, path: ".env", name: action === "add" ? "APP_PORT" : "PORT", value: 8080 },
			undefined,
			undefined,
			{
				cwd,
				hasUI: true,
				ui: approvalUi(),
			},
		);
		expect(result.isError).toBeUndefined();
		expect(parseEnv(readFileSync(join(cwd, ".env"), "utf-8"))).toEqual({
			PORT: action === "edit" ? "8080" : "3000",
			HOST: "api.example.com",
			TOKEN: "secret-value",
			...(action === "add" ? { APP_PORT: "8080" } : {}),
		});
		expect(result.content[0]?.text).toMatch(/^(Added|Edited) \w+ in .+ \(value hidden\)\.$/);
		if (process.platform !== "win32") expect(statSync(join(cwd, ".env")).mode & 0o777).toBe(0o600);
	});

	test("denial does not create a file", async () => {
		const result = await captureEnvRead().execute(
			"1",
			{ action: "add", path: ".env.examples", name: "APP_PORT", value: 8080 },
			undefined,
			undefined,
			{ cwd, hasUI: true, ui: approvalUi(false) },
		);
		expect(result.content[0]?.text).toMatch(/^read_env denied: APP_PORT$/);
		expect(existsSync(join(cwd, ".env.examples"))).toBe(false);
	});

	test("approval creates a nonstandard env file", async () => {
		const result = await captureEnvRead().execute(
			"1",
			{ action: "add", path: ".env.examples", name: "APP_PORT", value: 8080 },
			undefined,
			undefined,
			{ cwd, hasUI: true, ui: approvalUi() },
		);
		expect(result.isError).toBeUndefined();
		expect(parseEnv(readFileSync(join(cwd, ".env.examples"), "utf-8"))).toEqual({
			APP_PORT: "8080",
		});
	});

	test("concurrent file changes during approval are not overwritten", async () => {
		const changed = "PORT=9000\n";
		const result = await captureEnvRead().execute(
			"1",
			{ action: "edit", path: ".env", name: "PORT", value: 8080 },
			undefined,
			undefined,
			{ cwd, hasUI: true, ui: approvalUi(true, () => writeFileSync(join(cwd, ".env"), changed)) },
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("changed during approval");
		expect(readFileSync(join(cwd, ".env"), "utf-8")).toBe(changed);
	});

	// File symlinks require admin or Developer Mode on Windows; POSIX CI runs this boundary check.
	test.skipIf(process.platform === "win32")(
		"symlinks cannot redirect writes or disguise a non-env read",
		async () => {
			const file = join(cwd, "notes.txt");
			writeFileSync(file, "PRIVATE=unchanged\n");
			const link = join(cwd, ".env.link");
			symlinkSync(file, link);
			const tool = captureEnvRead();
			const write = await tool.execute(
				"1",
				{ action: "add", path: link, name: "APP_PORT", value: 8080 },
				undefined,
				undefined,
				{ cwd, hasUI: true, ui: approvalUi() },
			);
			expect(write.isError).toBe(true);
			const read = await tool.execute("2", { action: "info", path: link }, undefined, undefined, {
				cwd,
			});
			expect(read.isError).toBe(true);
			expect(readFileSync(file, "utf-8")).toBe("PRIVATE=unchanged\n");
		},
	);

	test("read reveals only requested values after approval", async () => {
		const tool = captureEnvRead();
		const result = await tool.execute(
			"1",
			{ action: "read", names: ["TOKEN"] },
			undefined,
			undefined,
			{
				cwd,
				hasUI: true,
				ui: {
					custom: async <T>(build: (...args: any[]) => unknown) => {
						let answer: T | undefined;
						const component = build(
							{ requestRender() {} },
							{
								fg: (_c: string, text: string) => text,
								bg: (_c: string, text: string) => text,
								bold: (text: string) => text,
							},
							undefined,
							(value: T) => {
								answer = value;
							},
						) as { render(width: number): string[]; handleInput(data: string): void };
						component.render(80);
						component.handleInput("\x1b[B");
						component.handleInput("\r");
						return answer;
					},
				},
			},
		);
		expect(result.content[0]?.text).toBe("TOKEN=secret-value");
		expect(result.content[0]?.text).not.toContain("api.example.com");
	});

	test("renders info with type icons and accent-colored names", () => {
		const tool = captureEnvRead();
		const theme = { fg: (color: string, text: string) => `[${color}]${text}[/]` };
		const result = {
			content: [
				{ type: "text", text: "ENABLED = boolean\nHOST = string\nPORT = int\nRATE = float" },
			],
			details: {
				action: "info",
				types: { ENABLED: "boolean", HOST: "string", PORT: "int", RATE: "float" },
			},
		};
		const lines = tool
			.renderResult(result, { isPartial: false }, theme, makeRenderCtx())
			.render(80);
		const body = lines.slice(0, -1).join("\n");

		expect(body).toContain("[accent]ENABLED[/]");
		expect(body).toContain("[accent]HOST[/]");
		expect(body).toContain("[accent]PORT[/]");
		expect(body).toContain("[accent]RATE[/]");
		expect(body).not.toContain("ENABLED = boolean");
		expect(body.match(/\[accent\]/g)).toHaveLength(4);
	});

	test("frames successful results green and errors red", () => {
		const tool = captureEnvRead();
		const theme = { fg: (color: string, text: string) => `[${color}]${text}[/]` };
		const result = { content: [{ type: "text", text: "HOST = string" }] };
		const success = tool.renderResult(result, { isPartial: false }, theme, makeRenderCtx());
		const failure = tool.renderResult(
			result,
			{ isPartial: false },
			theme,
			makeRenderCtx({ isError: true }),
		);

		const successLines = success.render(20);
		const failureLines = failure.render(20);
		expect(successLines[0]?.trimEnd()).toBe("HOST = string");
		expect(successLines[1]).toBe(`[success]${"- ".repeat(10)}[/]`);
		expect(failureLines[0]?.trimEnd()).toBe("HOST = string");
		expect(failureLines[1]).toBe(`[error]${"- ".repeat(10)}[/]`);
	});

	test("read rejects missing names and no-UI disclosure", async () => {
		const tool = captureEnvRead();
		const missing = await tool.execute("1", { action: "read" }, undefined, undefined, {
			cwd,
			hasUI: true,
			ui: {},
		});
		expect(missing.isError).toBe(true);
		expect(missing.content[0]?.text).toContain("names is required");

		const noUi = await tool.execute(
			"2",
			{ action: "read", names: ["TOKEN"] },
			undefined,
			undefined,
			{ cwd, hasUI: false, ui: {} },
		);
		expect(noUi.isError).toBe(true);
		expect(noUi.content[0]?.text).not.toContain("secret-value");
	});
});

test("W1 capture: read_env component and default Box results", async () => {
	const fixture = await withUiFixture();
	try {
		const tool = captureEnvRead();
		const typed = {
			content: [
				{ type: "text", text: "ENABLED = boolean\nPORT = int\nRATE = float\nTOKEN = string" },
			],
			details: {
				action: "info",
				types: { ENABLED: "boolean", PORT: "int", RATE: "float", TOKEN: "string" },
			},
		};
		const component = tool.renderResult(typed, { isPartial: false }, roleTheme(), {
			isError: false,
		});
		expect(captureRows(component, { width: 80, surface: "component" })).toMatchSnapshot(
			"typed component",
		);
		for (const [name, value, isPartial, isError] of [
			["typed Box", typed, false, false],
			["partial keeps current close", typed, true, false],
			["names fallback", { content: [{ type: "text", text: "TOKEN = string" }] }, false, false],
			[
				"synthetic read",
				{ content: [{ type: "text", text: "TOKEN=fixture-value" }], details: { action: "read" } },
				false,
				false,
			],
			[
				"error",
				{ content: [{ type: "text", text: "read_env requires interactive user approval." }] },
				false,
				true,
			],
			[
				"empty typed body",
				{
					content: [{ type: "text", text: "No env variables loaded." }],
					details: { action: "info", types: {} },
				},
				false,
				false,
			],
		] as const) {
			const rendered = tool.renderResult(
				{ ...value, content: [...value.content] },
				{ isPartial },
				roleTheme(),
				{ isError },
			);
			expect(captureRows(rendered, { width: 80, surface: "host-box" })).toMatchSnapshot(name);
		}
	} finally {
		await fixture.restore();
	}
});

function approvalUi(approve = true, beforeAnswer = () => {}) {
	return {
		custom: async <T>(build: (...args: any[]) => unknown) => {
			let answer: T | undefined;
			const component = build(
				{ requestRender() {} },
				{
					fg: (_c: string, text: string) => text,
					bg: (_c: string, text: string) => text,
					bold: (text: string) => text,
				},
				undefined,
				(value: T) => {
					answer = value;
				},
			) as { render(width: number): string[]; handleInput(data: string): void };
			component.render(80);
			beforeAnswer();
			if (approve) component.handleInput("\x1b[B");
			component.handleInput("\r");
			return answer;
		},
	};
}

describe("env writes", () => {
	test.each([
		".env",
		".env.examples",
		".env.production.local",
		".env.my-app_1",
	])("accepts %s", (name) => {
		expect(envPath(name, tempDir())).toBe(join(tempDir(), name));
	});

	test.each([
		"8080",
		"",
		"false",
		"with # comment",
		"a'b\"c\\path",
		" space ",
		"$HOME",
	])("values round-trip: %j", (value) => {
		expect(parseEnv(editEnvText("", "APP_PORT", value, "add"))).toEqual({ APP_PORT: value });
	});

	test("preserves other assignments, comments, exports, and line endings", () => {
		const before = "# keep\r\nexport APP_PORT=3000\r\nTOKEN=unchanged\r\n";
		expect(editEnvText(before, "APP_PORT", "8080", "edit")).toBe(
			'# keep\r\nexport APP_PORT="8080"\r\nTOKEN=unchanged\r\n',
		);
		expect(editEnvText("# keep", "APP_PORT", "8080", "add")).toBe('# keep\nAPP_PORT="8080"\n');
	});

	test.each([
		["APP_PORT=3000 # port", 'APP_PORT="8080" # port'],
		["APP_PORT= # empty", 'APP_PORT= "8080" # empty'],
		['  export APP_PORT  =  "old # value"\t# port\r\n', '  export APP_PORT  =  "8080"\t# port\r\n'],
		["APP_PORT='old # value' # port", 'APP_PORT="8080" # port'],
		['APP_PORT="old \\"quote"#port', 'APP_PORT="8080"#port'],
		["APP_PORT=3000\t\t# port\n", 'APP_PORT="8080"\t\t# port\n'],
		["APP_PORT=old#value", 'APP_PORT="8080"'],
	])("edit preserves formatting and comments in %j", (before, expected) => {
		const edited = editEnvText(before, "APP_PORT", "8080", "edit");
		expect(edited).toBe(expected);
		expect(parseEnv(edited)).toEqual({ APP_PORT: "8080" });
	});

	test("rejects duplicate keys, missing keys, invalid names, and multiline injection", () => {
		expect(() => editEnvText("APP_PORT=1\n", "APP_PORT", "2", "add")).toThrow("already exists");
		expect(() => editEnvText("", "APP_PORT", "2", "edit")).toThrow("exactly one");
		expect(() => editEnvText("APP_PORT=1\nAPP_PORT=2", "APP_PORT", "3", "edit")).toThrow(
			"exactly one",
		);
		for (const name of ["", "1PORT", "PORT=X", "A\nB", "PORT\n"])
			expect(() => editEnvText("", name, "x", "add")).toThrow("invalid env variable name");
		for (const value of ["x\ny", "x\ry", "x\0y"])
			expect(() => editEnvText("", "KEY", value, "add")).toThrow("single line");
		for (const text of ['TOKEN="first\nAPP_PORT=1\nlast"', "TOKEN='unterminated"])
			expect(() => editEnvText(text, "NEW", "x", "add")).toThrow(/multiline|unterminated/);
	});
});

test("secretTarget shows the unresolved command, else the raw input", () => {
	expect(secretTarget({ command: "curl -H $TOKEN x" })).toBe("curl -H $TOKEN x");
	expect(secretTarget({ url: "https://h/$TOKEN" })).toBe('{"url":"https://h/$TOKEN"}');
});

describe("parseEnv", () => {
	test("handles export, comments, quotes, inline comments", () => {
		const env = parseEnv(
			[
				"# comment",
				"",
				"API_KEY=sk-123",
				"export TOKEN=abc",
				`QUOTED="a b c"`,
				"SINGLE='x y'",
				"PORT=3000 # inline",
			].join("\n"),
		);
		expect(env).toEqual({
			API_KEY: "sk-123",
			TOKEN: "abc",
			QUOTED: "a b c",
			SINGLE: "x y",
			PORT: "3000",
		});
	});

	test("parses comments outside quotes without changing quoted hashes", () => {
		expect(parseEnv("A=\"a # b\" # note\nB='c # d'\t# note\nC=raw#hash\nD=raw\t# note")).toEqual({
			A: "a # b",
			B: "c # d",
			C: "raw#hash",
			D: "raw",
		});
	});

	test("retains prototype-like env names as data", () => {
		expect(Object.entries(parseEnv("__proto__=data\nconstructor=text"))).toEqual([
			["__proto__", "data"],
			["constructor", "text"],
		]);
	});

	test("ignores malformed lines", () => {
		expect(parseEnv("not a var\n=missingkey\n123=bad")).toEqual({});
	});
});

describe("describeRegistry", () => {
	test("reports value shapes without exposing values", () => {
		const reg = new Map([
			["PORT", "3000"],
			["RATE", "1.5"],
			["ENABLED", "true"],
			["HOST", "api.example.com"],
		]);
		expect(describeRegistry(reg)).toEqual({
			ENABLED: "boolean",
			HOST: "string",
			PORT: "int",
			RATE: "float",
		});
	});
});

describe("refsIn / collectRefs", () => {
	const reg = new Map([
		["API_KEY", "sk-1"],
		["TOKEN", "t-2"],
	]);
	test("detects bare and braced refs, only known keys", () => {
		expect(refsIn(`Bearer $API_KEY and ${braced("TOKEN")} and $UNKNOWN`, reg).sort()).toEqual([
			"API_KEY",
			"TOKEN",
		]);
	});
	test("walks nested input objects and arrays", () => {
		const input = { url: "https://x/?k=$API_KEY", headers: [`Auth: ${braced("TOKEN")}`], n: 5 };
		expect(collectRefs(input, reg).sort()).toEqual(["API_KEY", "TOKEN"]);
	});
});

describe("resolveString", () => {
	const reg = new Map([["API_KEY", "sk-1"]]);
	test("raw substitution for non-shell", () => {
		expect(resolveString("k=$API_KEY", reg, false)).toBe("k=sk-1");
	});
	test("shell-quotes for bash", () => {
		expect(resolveString("k=$API_KEY", reg, true)).toBe("k='sk-1'");
	});
	test("leaves unknown refs untouched", () => {
		expect(resolveString("$OTHER", reg, false)).toBe("$OTHER");
	});
});

describe("unsupportedRefs / collectUnsupported", () => {
	const reg = new Map([["HOST", "https://x"]]);
	// braced-with-modifier forms, assembled so no plain ${...} appears in source
	const mod = (body: string) => L + body + R;
	test("detects each bash parameter-expansion modifier for known keys", () => {
		for (const form of ["HOST:-def", "HOST%/", "HOST#p", "HOST/a/b", "HOST^^", "HOST:0:5"]) {
			expect(unsupportedRefs(`curl ${mod(form)}/x`, reg)).toEqual(["HOST"]);
		}
	});
	test("does not flag plain bare or braced refs", () => {
		expect(unsupportedRefs(`$HOST and ${braced("HOST")}`, reg)).toEqual([]);
	});
	test("ignores modifier forms for unknown keys", () => {
		expect(unsupportedRefs(`${mod("OTHER:-x")}`, reg)).toEqual([]);
	});
	test("walks nested input", () => {
		expect(collectUnsupported({ command: `curl ${mod("HOST%/")}/api` }, reg)).toEqual(["HOST"]);
	});
});

describe("allRefsIn / shellPrelude", () => {
	const reg = new Map([
		["HOST", "https://x/"],
		["TOKEN", "t-2"],
	]);
	const mod = (b: string) => L + b + R;
	test("allRefsIn unions plain, braced and modifier forms", () => {
		expect(allRefsIn(`$HOST ${braced("TOKEN")} ${mod("HOST%/")}`, reg).sort()).toEqual([
			"HOST",
			"TOKEN",
		]);
	});
	test("shellPrelude exports quoted values for known keys only", () => {
		expect(shellPrelude(["HOST", "UNKNOWN"], reg)).toBe(`export HOST='https://x/'\n`);
	});
	test("empty keys yields empty prelude", () => {
		expect(shellPrelude([], reg)).toBe("");
	});
});

describe("shellQuote", () => {
	test("escapes embedded single quotes", () => {
		expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
	});
});

describe("resolveInput", () => {
	const reg = new Map([["TOKEN", "t-2"]]);
	test("mutates nested object in place", () => {
		const input = { a: "x $TOKEN", b: { c: [braced("TOKEN")] }, n: 1 };
		resolveInput(input, reg, false);
		expect(input).toEqual({ a: "x t-2", b: { c: ["t-2"] }, n: 1 });
	});
});
