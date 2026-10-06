import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TextComponentLike } from "@xynogen/pix-pretty/types";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

let fixture: Awaited<ReturnType<typeof withUiFixture>>;
const theme = roleTheme();
const terminal = (width: number) => fixture.setWidth(width);
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
	fixture = await withUiFixture();
	try {
		({ renderCall, renderResult } = await import("./codemode.ts"));
	} catch (error) {
		await fixture.restore();
		throw error;
	}
});
beforeEach(async () => {
	terminal(80);
	await fixture.runtime.update(collapseSection, (current) => ({
		...current,
		enabled: false,
		tools: {},
	}));
});
afterAll(async () => {
	await fixture?.restore();
});

function capture(component: TextComponentLike, width: 80 | 120): string[] {
	if (!component.render) throw new Error("The fixture needs a renderable component");
	return captureRows({ render: (w) => component.render!(w) }, { width, surface: "component" });
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

test("highlights long JSON values and wraps the normal output without losing text", () => {
	const value = `${"abcdefghij".repeat(250)} END-OF-VALUE`;
	const payload = JSON.stringify({ status: "fulfilled", value, count: 1, ok: true, empty: null });
	const lines = capture(renderResult(result(payload), options, theme, context()), 80);
	const text = lines.join("\n");
	expect(text).toContain('<syntaxVariable>"status"</syntaxVariable>');
	expect(text).toContain("<syntaxString>");
	expect(text).toContain("END-OF-VALUE");
	expect(text).toContain("<syntaxNumber>1</syntaxNumber>");
	expect(text).toContain("<syntaxKeyword>true</syntaxKeyword>");
	close(lines, "success", 80);
});

test("preserves escaped strings and colors JSON arrays and scalar values", () => {
	const payload = JSON.stringify({
		'key"name': 'quote" slash\\ newline\n',
		values: [-1.25e30, false, null],
	});
	const lines = capture(renderResult(result(payload), options, theme, context()), 80);
	const text = lines.join("\n");
	expect(text).toContain('<syntaxVariable>"key\\"name"</syntaxVariable>');
	expect(text).toContain('<syntaxString>"quote\\" slash\\\\ newline\\n"</syntaxString>');
	expect(text).toContain("<syntaxNumber>-1.25e+30</syntaxNumber>");
	expect(text).toContain("<syntaxKeyword>false</syntaxKeyword>");
	expect(text).toContain("<syntaxKeyword>null</syntaxKeyword>");
	expect(text).toContain("<syntaxPunctuation>[</syntaxPunctuation>");
	close(lines, "success", 80);
});

test("command-result JSON renders raw output and preserves its metadata", () => {
	for (const expanded of [false, true]) {
		for (const exit_code of [0, 2]) {
			const envelope = {
				output: 'first\n  second\n{"raw":true}',
				truncated: exit_code !== 0,
				exit_code,
				wall_time_seconds: 1.25,
				full_output_path: "fixtures/full.txt",
			};
			const payload = result(JSON.stringify(envelope));
			const before = JSON.stringify(payload);
			const lines = capture(renderResult(payload, { ...options, expanded }, theme, context()), 80);
			expect(lines.slice(0, 3).map((line) => line.trimEnd())).toEqual([
				"<toolOutput>first</toolOutput>",
				"<toolOutput>  second</toolOutput>",
				'<toolOutput>{"raw":true}</toolOutput>',
			]);
			const text = lines.join("\n");
			expect(text).toContain(`exit ${exit_code}`);
			expect(text).toContain("command 1.3s");
			expect(text).toContain(`truncated: ${envelope.truncated}`);
			expect(text).toContain("Full output: fixtures/full.txt");
			close(lines, exit_code === 0 ? "success" : "error", 80);
			expect(JSON.stringify(payload)).toBe(before);
		}
	}
});

test("nested command output and metadata align with the child tool name", () => {
	for (const expanded of [false, true]) {
		const calls = [{ id: "1", name: "bash", args: "{}", status: "ok" as const }];
		const payload = result(
			JSON.stringify({
				output: "first\n  second",
				truncated: false,
				exit_code: 0,
				wall_time_seconds: 1,
				full_output_path: "fixtures/command.txt",
			}),
		);
		const lines = capture(
			renderResult(
				{ ...payload, details: { calls, fullOutputPath: "fixtures/script.txt" } },
				{ ...options, expanded },
				theme,
				context(),
			),
			80,
		).map((line) => line.replace(/<[^>]+>/g, "").trimEnd());
		const column = visibleWidth(lines[0]!.slice(0, lines[0]!.indexOf("bash")));
		expect(lines[1]).toBe(`${" ".repeat(column)}first`);
		expect(lines[2]).toBe(`${" ".repeat(column + 2)}second`);
		for (const line of lines.slice(3, -1)) {
			expect(line.match(/^ */)?.[0].length).toBe(column);
		}
	}
});

test("unknown or malformed command envelopes keep all JSON fields", () => {
	for (const extra of [{ extra: "keep-me" }, { truncated: "invalid" }, { wall_time_seconds: -1 }]) {
		const envelope = {
			output: "first\nsecond",
			truncated: false,
			exit_code: 0,
			wall_time_seconds: 1,
			...extra,
		};
		const lines = capture(
			renderResult(result(JSON.stringify(envelope)), options, theme, context()),
			80,
		);
		expect(lines.join("\n")).toContain('<syntaxVariable>"output"</syntaxVariable>');
		for (const key of Object.keys(extra)) {
			expect(lines.join("\n")).toContain(`<syntaxVariable>"${key}"</syntaxVariable>`);
		}
	}
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
	test(`long result wraps preview and expansion at ${width} columns`, () => {
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
test("JSON output omits host header and closes with success", () => {
	const lines = capture(renderResult(result(), options, theme, context()), 80);
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
test("child calls use the parent icon column with four spaces of indentation", async () => {
	const parent = (await call("return 1;", 80))[0]!.replace(/<[^>]+>/g, "");
	const calls = (["running", "ok", "error", "cancelled"] as const).map((status) => ({
		id: status,
		name: "read",
		args: "file.ts",
		status,
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
	for (const line of lines) {
		const plain = line.replace(/<[^>]+>/g, "");
		expect(plain.indexOf("read")).toBe(parent.indexOf("codemode") + 4);
	}
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
test("mixed call status, empty output and image placeholder", () => {
	const calls = ["ok", "error", "cancelled"].map((status, i) => ({
		id: `${i}`,
		name: "read",
		args: `file${i}`,
		status: status as "ok" | "error" | "cancelled",
		durationMs: 100,
		cost: 0.01,
	}));
	expect(
		capture(
			renderResult({ ...result("plain"), details: { calls } }, options, theme, context()),
			80,
		),
	).toMatchSnapshot("statuses");
	expect(
		capture(renderResult({ content: [], details: {} }, options, theme, context()), 80),
	).toMatchSnapshot("empty");
	expect(
		capture(
			renderResult(
				{ content: [{ type: "image", mimeType: "image/png", data: "fixture" }], details: {} },
				options,
				theme,
				context(),
			),
			80,
		),
	).toMatchSnapshot("image");
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

test("child results hide script output in preview and preserve expansion and errors", () => {
	const payload = {
		...result("script-only-value"),
		details: {
			calls: [
				{
					id: "1",
					name: "bash",
					args: "{}",
					status: "ok" as const,
					result: { content: [{ type: "text" as const, text: "child-value" }], details: {} },
				},
			],
		},
	};
	const before = JSON.stringify(payload);
	const preview = capture(renderResult(payload, options, theme, context()), 80);
	expect(preview.join("\n")).toContain("bash");
	expect(preview[0]).toMatch(/codemode.*0\.3s/);
	expect(preview.filter((line) => line.includes("0.3s"))).toHaveLength(1);
	expect(preview.join("\n")).not.toContain("script-only-value");
	expect(preview.join("\n")).not.toContain("Script output");
	close(preview, "success", 80);
	const expanded = capture(
		renderResult(payload, { ...options, expanded: true }, theme, context()),
		80,
	);
	expect(expanded.join("\n")).toContain("child-value");
	expect(expanded.join("\n")).toContain("script-only-value");
	close(expanded, "success", 80);
	const failed = capture(
		renderResult(payload, options, theme, { ...context(), isError: true }),
		80,
	);
	expect(failed.join("\n")).toContain("script-only-value");
	close(failed, "error", 80);
	expect(JSON.stringify(payload)).toBe(before);
});
