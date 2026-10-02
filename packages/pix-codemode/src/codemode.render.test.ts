import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { getIconMode, setIconMode } from "@xynogen/pix-pretty/icon-catalog";
import { makeTheme } from "@xynogen/pix-pretty/test-utils";
import type { TextComponentLike, ThemeLike } from "@xynogen/pix-pretty/types";
import { collapseSection, prettySection } from "@xynogen/pix-runtime/sections";
import { createIsolatedRuntime } from "@xynogen/pix-runtime/testing";

const fixture = createIsolatedRuntime();
const singleton = Symbol.for("@xynogen/pix-runtime");
const globals = globalThis as unknown as Record<symbol, unknown>;
const previousRuntime = globals[singleton];
const previousIcons = getIconMode();
const fixedEnv = {
	PRETTY_MAX_PREVIEW_LINES: "80",
	PRETTY_MAX_HL_CHARS: "80000",
	PRETTY_MAX_HL_LINE_CHARS: "2000",
	PRETTY_CACHE_LIMIT: "128",
};
const previousEnv = Object.fromEntries(Object.keys(fixedEnv).map((key) => [key, process.env[key]]));
const stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const stderrColumns = Object.getOwnPropertyDescriptor(process.stderr, "columns");
function terminal(width: 80 | 120) {
	Object.defineProperty(process.stdout, "columns", { configurable: true, value: width });
	Object.defineProperty(process.stderr, "columns", { configurable: true, value: width });
	process.stdout.emit("resize");
}
const roles = [
	"toolTitle",
	"toolOutput",
	"success",
	"error",
	"dim",
	"muted",
	"warning",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
];
const theme: ThemeLike = {
	...makeTheme(),
	fg: (role, text) => {
		const index = roles.indexOf(role);
		if (index < 0) throw new Error(`Unknown fixture role: ${role}`);
		return `\u001b[38;5;${100 + index}m${text}\u001b[39m`;
	},
};
const options = { expanded: false, isPartial: false };
const context = (state = {}) => ({ state, expanded: false, invalidate: () => {} });
const result = (text = '{"ok":true}', failed = false) => ({
	content: [
		{
			type: "text" as const,
			text: `Script ${failed ? "failed" : "completed"}\nWall time 0.25 seconds\nOutput:\n`,
		},
		{ type: "text" as const, text },
	],
	details: {},
});
let renderCall: typeof import("./codemode.ts").renderCall;
let renderResult: typeof import("./codemode.ts").renderResult;

beforeAll(async () => {
	Object.assign(process.env, fixedEnv);
	globals[singleton] = fixture.runtime;
	await fixture.runtime.init();
	await fixture.runtime.update(prettySection, { icons: "ascii", maxPreviewLines: 80 });
	setIconMode("ascii");
	({ renderCall, renderResult } = await import("./codemode.ts"));
});
beforeEach(async () => {
	terminal(80);
	await fixture.runtime.update(collapseSection, { enabled: false, tools: {} });
});
afterAll(async () => {
	await fixture.runtime.shutdown();
	globals[singleton] = previousRuntime;
	setIconMode(previousIcons);
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (stdoutColumns) Object.defineProperty(process.stdout, "columns", stdoutColumns);
	else Reflect.deleteProperty(process.stdout, "columns");
	if (stderrColumns) Object.defineProperty(process.stderr, "columns", stderrColumns);
	else Reflect.deleteProperty(process.stderr, "columns");
	process.stdout.emit("resize");
	fixture.cleanup();
});

// ponytail: local pilot capture avoids a public test API. Share it only after a wider migration needs it.
function capture(component: TextComponentLike, width: 80 | 120): string[] {
	if (!component.render) throw new Error("The fixture needs a renderable component");
	return component.render(width).map((line) => {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		let role: string | undefined;
		let output = "";
		let offset = 0;
		for (const match of line.matchAll(/\u001b\[([\d;]*)m/g)) {
			output += line.slice(offset, match.index);
			if (role) output += `</${role}>`;
			role = undefined;
			const color = /^38;5;(\d+)$/.exec(match[1] ?? "");
			if (color) {
				role = roles[Number(color[1]) - 100];
				if (!role) throw new Error(`Unknown fixture ANSI: ${match[0]}`);
				output += `<${role}>`;
			} else if (!["0", "39", "49"].includes(match[1] ?? "")) {
				throw new Error(`Unexpected fixture ANSI: ${match[0]}`);
			}
			offset = match.index + match[0].length;
		}
		output += line.slice(offset);
		if (role) output += `</${role}>`;
		return output;
	});
}
function close(lines: string[], role: "success" | "error", width: number) {
	expect(lines.at(-1)).toBe(`<${role}>${"- ".repeat(width / 2)}</${role}>`);
}

// hlBlock does synchronous cli-highlight work, then resolves its async signature.
// Await the renderer's invalidate callback, not elapsed wall time or a guessed microtask count.
async function call(code: string, width: 80 | 120, expanded = false) {
	terminal(width);
	const ready = Promise.withResolvers<void>();
	const ctx = { ...context(), expanded, invalidate: () => ready.resolve() };
	renderCall({ code }, theme, ctx);
	await ready.promise;
	return capture(renderCall({ code }, theme, ctx), width);
}

test("capture preserves real Text padding, blank rows and semantic roles", () => {
	const lines = capture(new Text(theme.fg("dim", "a\n\nb"), 1, 1), 80);
	expect(lines.length).toBe(5);
	expect(lines[0]).toBe(" ".repeat(80));
	expect(lines.at(-1)).toBe(" ".repeat(80));
	expect(lines[1]).toMatch(/^ <dim>a +<\/dim>$/);
	expect(lines).toMatchSnapshot();
});
test("normal call at 80 columns", async () => {
	expect(await call("return 1;", 80)).toMatchSnapshot();
});
test("truncated and expanded call at 80 columns", async () => {
	const code = Array.from({ length: 20 }, (_, i) => `const n${i} = ${i};`).join("\n");
	expect(await call(code, 80)).toMatchSnapshot("preview");
	expect(await call(code, 80, true)).toMatchSnapshot("expanded");
});
for (const width of [80, 120] as const) {
	test(`long call wraps at ${width} columns`, async () => {
		expect(await call(`return "${"abcdefghij".repeat(13)}";`, width)).toMatchSnapshot();
	});
	test(`long result clips preview and wraps expansion at ${width} columns`, () => {
		terminal(width);
		const output = result(`first\n\n${"abcdefghij".repeat(15)}\nlast`);
		const preview = capture(renderResult(output, options, theme, context()), width);
		close(preview, "success", width);
		expect(preview).toMatchSnapshot("preview");
		const expanded = capture(
			renderResult(output, { ...options, expanded: true }, theme, context()),
			width,
		);
		close(expanded, "success", width);
		expect(expanded).toMatchSnapshot("expanded");
	});
}
test("JSON output omits host header and closes with success", async () => {
	const ready = Promise.withResolvers<void>();
	const ctx = { ...context(), invalidate: () => ready.resolve() };
	renderResult(result(), options, theme, ctx);
	await ready.promise;
	const lines = capture(renderResult(result(), options, theme, ctx), 80);
	close(lines, "success", 80);
	expect(lines.join("\n")).not.toContain("Script completed");
	expect(lines).toMatchSnapshot();
});
test("collapsed success hides the call and expansion restores the body", async () => {
	await fixture.runtime.update(collapseSection, { enabled: true });
	const ctx = context({ collapsed: true });
	expect(capture(renderResult(result(), options, theme, ctx), 80)).toMatchSnapshot("collapsed");
	expect(capture(renderCall({ code: "return 1;" }, theme, ctx), 80)).toEqual([]);
	const expanded = capture(
		renderResult(result("plain"), { ...options, expanded: true }, theme, ctx),
		80,
	);
	close(expanded, "success", 80);
	expect(expanded).toMatchSnapshot("expanded");
});
test("failed output remains visible with an error close", () => {
	const lines = capture(
		renderResult(
			result("Script error:\nbad input", true),
			options,
			theme,
			context({ collapsed: true }),
		),
		80,
	);
	close(lines, "error", 80);
	expect(lines).toMatchSnapshot();
});
test("partial output shows the latest eight calls without a completed frame", () => {
	const calls = Array.from({ length: 10 }, (_, i) => ({
		id: `${i}`,
		name: "read",
		args: `file${i}`,
		status: "running" as const,
	}));
	const lines = capture(
		renderResult(
			{ ...result(), details: { calls } },
			{ ...options, isPartial: true },
			theme,
			context(),
		),
		80,
	);
	expect(lines.length).toBe(9);
	expect(lines.join("\n")).not.toContain("<success>");
	expect(lines).toMatchSnapshot();
});
test("unknown host output and full-output path remain intact", () => {
	const lines = capture(
		renderResult(
			{
				content: [{ type: "text", text: "new host header\nraw output" }],
				details: { fullOutputPath: "fixtures/full.txt" },
			},
			options,
			theme,
			context(),
		),
		80,
	);
	close(lines, "success", 80);
	expect(lines).toMatchSnapshot();
});
