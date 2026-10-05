import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import registerEnv from "./extension.ts";
import {
	allRefsIn,
	collectRefs,
	collectUnsupported,
	describeRegistry,
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
	execute: (
		id: string,
		params: { action: "info" | "read"; path?: string; names?: string[] },
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
		const alt = join(cwd, "other.env");
		writeFileSync(alt, "ALPHA=1\nBETA=two\n");
		const result = await tool.execute("1", { action: "info", path: alt }, undefined, undefined, {
			cwd,
			hasUI: false,
			ui: {},
		});
		expect(result.content[0]?.text).toBe("ALPHA = int\nBETA = string");
	});

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
			.renderResult(result, { isPartial: false }, theme, { isError: false })
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
		const success = tool.renderResult(result, { isPartial: false }, theme, { isError: false });
		const failure = tool.renderResult(result, { isPartial: false }, theme, { isError: true });

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
