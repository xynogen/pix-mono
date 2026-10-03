import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { getIconMode, setIconMode } from "@xynogen/pix-pretty/icon-catalog";
import { capturePi, makeRenderCtx, makeToolContext } from "@xynogen/pix-pretty/test-utils";
import type { GrepResultDetails, ThemeLike, ToolResultLike } from "@xynogen/pix-pretty/types";
import { collapseSection, prettySection } from "@xynogen/pix-runtime/sections";
import { createIsolatedRuntime } from "@xynogen/pix-runtime/testing";

const roles = ["toolTitle", "dim", "muted", "success", "error", "accent", "warning"];
// Apply zero-width ANSI before layout. Decode roles only after real Text renders the rows.
const theme: ThemeLike = {
	fg: (role, value) => {
		const index = roles.indexOf(role);
		if (index === -1) throw new Error(`Unknown fixture role: ${role}`);
		return `\x1b[${31 + index}m${value}\x1b[39m`;
	},
	bold: (value) => `\x1b[1m${value}\x1b[22m`,
};

function semanticRow(line: string): string {
	let role = "";
	let bold = false;
	let offset = 0;
	const runs: { style: string; text: string }[] = [];
	const append = (text: string) => {
		if (!text) return;
		const style = [role, bold ? "bold" : ""].filter(Boolean).join("+");
		const last = runs.at(-1);
		if (last?.style === style) last.text += text;
		else runs.push({ style, text });
	};
	for (const match of line.matchAll(/\x1b\[([\d;]*)m/g)) {
		append(line.slice(offset, match.index));
		for (const code of (match[1] || "0").split(";").map(Number)) {
			if (code === 0) {
				role = "";
				bold = false;
			} else if (code === 39) role = "";
			else if (code === 1) bold = true;
			else if (code === 22) bold = false;
			else if (code >= 31 && code <= 37) role = roles[code - 31] ?? "";
			else if (code !== 49) throw new Error(`Unknown fixture SGR: ${code}`);
		}
		offset = match.index + match[0].length;
	}
	append(line.slice(offset));
	return runs.map(({ style, text }) => (style ? `<${style}>${text}</${style}>` : text)).join("");
}

const singleton = Symbol.for("@xynogen/pix-runtime");
const globals = globalThis as typeof globalThis & { [singleton]?: unknown };
const previousRuntime = globals[singleton];
const isolated = createIsolatedRuntime();
const previousIcons = getIconMode();
const previousEnv = new Map(
	["PRETTY_MAX_PREVIEW_LINES", "PRETTY_MAX_HL_CHARS", "PRETTY_MAX_HL_LINE_CHARS"].map((key) => [
		key,
		process.env[key],
	]),
);
const stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const stderrColumns = Object.getOwnPropertyDescriptor(process.stderr, "columns");
let terminalWidth = 80;
let tool: ReturnType<typeof capturePi>["tool"];

beforeAll(async () => {
	globals[singleton] = isolated.runtime;
	await isolated.runtime.init();
	await isolated.runtime.update(prettySection, {
		icons: "unicode",
		maxPreviewLines: 80,
		maxHighlightChars: 80_000,
	});
	await isolated.runtime.update(collapseSection, { enabled: true, delaySec: 10, tools: {} });
	setIconMode("unicode");
	process.env.PRETTY_MAX_PREVIEW_LINES = "80";
	process.env.PRETTY_MAX_HL_CHARS = "80000";
	process.env.PRETTY_MAX_HL_LINE_CHARS = "2000";
	Object.defineProperty(process.stdout, "columns", {
		configurable: true,
		get: () => terminalWidth,
	});
	Object.defineProperty(process.stderr, "columns", {
		configurable: true,
		get: () => terminalWidth,
	});
	// Import config consumers only after the isolated fixture is ready.
	const { registerGrepTool } = await import("./grep");
	const { viewportTextConstructor } = await import("@xynogen/pix-pretty/utils");
	const captured = capturePi();
	tool = captured.tool;
	registerGrepTool(
		captured.pi,
		() => ({
			execute: async () => {
				throw new Error("UI tests must not execute search tools");
			},
		}),
		makeToolContext({
			cwd: "/fixture/project",
			sp: (path) => path,
			TextComponent: viewportTextConstructor(Text),
		}),
	);
});

afterAll(async () => {
	try {
		await isolated.runtime.shutdown();
	} finally {
		isolated.cleanup();
		if (previousRuntime === undefined) delete globals[singleton];
		else globals[singleton] = previousRuntime;
		setIconMode(previousIcons);
		for (const [key, value] of previousEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (stdoutColumns) Object.defineProperty(process.stdout, "columns", stdoutColumns);
		else Reflect.deleteProperty(process.stdout, "columns");
		if (stderrColumns) Object.defineProperty(process.stderr, "columns", stderrColumns);
		else Reflect.deleteProperty(process.stderr, "columns");
		process.stdout.emit("resize");
	}
});

function result(text: string, pattern = "TODO", matchCount = 2): ToolResultLike<GrepResultDetails> {
	return {
		content: [{ type: "text", text }],
		details: { _type: "grepResult", text, pattern, path: "src", matchCount },
	};
}

function capture(
	fixture: ToolResultLike<GrepResultDetails>,
	{ width = 80, collapsed = false, expanded = false, isError = false, isPartial = false } = {},
) {
	terminalWidth = width;
	process.stdout.emit("resize");
	// ponytail: capture explicit states. Test timer scheduling separately when that policy changes.
	// A truthy timer marker prevents scheduling without creating a real timer or waiting.
	const state = { collapsed, timer: 1 };
	const context = makeRenderCtx({
		state,
		expanded,
		isError,
		invalidate: () => {
			throw new Error("UI capture must not schedule invalidation");
		},
	});
	const component = tool.renderResult?.(fixture, { isPartial }, theme, context);
	if (!component) throw new Error("Missing grep result renderer");
	const rows = component.render(width);
	for (const row of rows) expect(visibleWidth(row)).toBe(width);
	expect(state).toEqual({ collapsed, timer: 1 });
	return { rows: rows.map(semanticRow), plain: rows.map(stripVTControlCharacters) };
}

function expectClose(rows: string[], role: "success" | "error", width = 80) {
	expect(rows.at(-1)).toMatch(
		new RegExp(`^<${role}>(?:- ){${Math.floor(width / 2)}}<\\/${role}>$`),
	);
}

describe("grep UI", () => {
	const hits = "src/a.ts:1:TODO one\nsrc/b.ts:2:TODO two";

	it("captures the call title, target, path and glob roles", () => {
		terminalWidth = 80;
		process.stdout.emit("resize");
		const component = tool.renderCall?.(
			{ pattern: "TODO", path: "src", glob: "*.ts" },
			theme,
			makeRenderCtx({ state: { collapsed: false } }),
		);
		if (!component) throw new Error("Missing grep call renderer");
		const rows = component.render(80);
		expect(rows.map(visibleWidth)).toEqual([80]);
		expect(rows.map(semanticRow)).toMatchSnapshot();
	});

	it("captures a single hit with a full-width success close", () => {
		const { rows } = capture(result("src/a.ts:1:TODO one", "TODO", 1));
		expectClose(rows, "success");
		expect(rows).toMatchSnapshot();
	});

	it("captures multiple hits in order with the same success shape", () => {
		const { rows } = capture(result(hits));
		expectClose(rows, "success");
		expect(rows).toMatchSnapshot();
	});

	it("captures the unframed collapsed summary", () => {
		const { rows } = capture(result(hits), { collapsed: true });
		expect(rows).toHaveLength(1);
		expect(rows).toMatchSnapshot();
	});

	it("restores both complete hits when the collapsed card is expanded", () => {
		const { rows, plain } = capture(result(hits), { collapsed: true, expanded: true });
		expect(plain.slice(0, 2)).toEqual(hits.split("\n").map((line) => `   ${line}`.padEnd(80)));
		expectClose(rows, "success");
		expect(rows).toMatchSnapshot();
	});

	it("captures a structured error, its collapsed summary and its expanded diagnostic", () => {
		const diagnostic = "regex parse error: unclosed group";
		const fixture = result(diagnostic, "(", 0);
		const normal = capture(fixture, { isError: true });
		const collapsed = capture(fixture, { isError: true, collapsed: true });
		const expanded = capture(fixture, { isError: true, collapsed: true, expanded: true });
		for (const output of [normal, expanded]) {
			expect(output.plain[0]).toBe(diagnostic.padEnd(80));
			expectClose(output.rows, "error");
		}
		expect(collapsed.rows).toHaveLength(1);
		expect({
			normal: normal.rows,
			collapsed: collapsed.rows,
			expanded: expanded.rows,
		}).toMatchSnapshot();
	});

	it("captures a partial result without a completed close", () => {
		const { rows } = capture(result(hits), { isPartial: true, collapsed: true });
		expect(rows).toHaveLength(2);
		expect(rows).toMatchSnapshot();
	});

	for (const width of [80, 120]) {
		it(`captures long output at ${width} columns without a mock wrapping shortcut`, () => {
			const longHit = `src/long.ts:42:TODO ${"detail ".repeat(18)}END`;
			const { rows, plain } = capture(result(`${longHit}\n\n  src/b.ts:2:TODO two`), {
				width,
				expanded: true,
			});
			// Grep fits to the terminal before Text renders. This locks its actual truncation contract.
			expect(plain[0]).toBe(`   ${longHit}`.slice(0, width));
			expect(plain[1]).toBe(" ".repeat(width));
			expect(plain[2]).toBe("     src/b.ts:2:TODO two".padEnd(width));
			expectClose(rows, "success", width);
			expect(rows).toMatchSnapshot();
		});
	}
});
