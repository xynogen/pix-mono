import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	getMarkdownTheme,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { Box, CURSOR_MARKER, Markdown, Text, visibleWidth } from "@earendil-works/pi-tui";
import { getIconMode } from "@xynogen/pix-runtime/icon-catalog";
import * as testing from "@xynogen/pix-runtime/testing";
import { captureRows, roleTheme, semanticRow, withUiFixture } from "./ui-capture.ts";

const theme = roleTheme();
test("semantic decoder preserves whitespace and independent SGR states", () => {
	expect(semanticRow(` ${theme.fg("dim", "a")}  `)).toBe(" <dim>a</dim>  ");
	expect(semanticRow("\x1b[1;2;3;7;31;44mx\x1b[22my\x1b[23;27;39;49mz")).toBe(
		"<ansi.red+bg:ansi.blue+bold+italic+inverse+faint>x</ansi.red+bg:ansi.blue+bold+italic+inverse+faint><ansi.red+bg:ansi.blue+italic+inverse>y</ansi.red+bg:ansi.blue+italic+inverse>z",
	);
	expect(semanticRow("\x1b[38;2;100;180;120;48;2;18;42;28mx\x1b[0m ")).toBe(
		"<raw.green+bg:diff.add>x</raw.green+bg:diff.add> ",
	);
	expect(semanticRow("\x1b[mx\x1b[0m")).toBe("x");
	expect(semanticRow(`${CURSOR_MARKER}x`)).toBe("<cursor/>x");
	expect(semanticRow(theme.getThinkingBorderColor("high")("x"))).toBe("<accent>x</accent>");
});

test("decoder rejects unknown escapes, OSC, colors and controls", () => {
	for (const value of [
		"\x1b[2K",
		"\x1b]8;;https://example.com\x07",
		"\x1b[5mx",
		"\x1b[38;5;99mx",
		"\x1b[38;2;1;2;3mx",
		"\x1b[38;2;1m",
		"\x1b",
		"\x07",
		"\x9b31m",
		"a\rb",
	])
		expect(() => semanticRow(value)).toThrow();
	expect(() => theme.fg("unknown", "x")).toThrow();
});

test("real Text preserves padding, blanks, roles and three-cell tabs", () => {
	const rows = captureRows(new Text(theme.fg("dim", "a\n\nb"), 1, 1), {
		width: 80,
		surface: "component",
	});
	expect(rows).toHaveLength(5);
	expect(rows[0]).toBe(" ".repeat(80));
	expect(rows[1]).toMatch(/^ <dim>a +<\/dim>$/);
	expect(rows[2]).toMatch(/^ <dim> +<\/dim>$/);
	expect(rows[4]).toBe(" ".repeat(80));
	expect(captureRows(new Text("\tx", 0, 0), { width: 8, surface: "component" })).toEqual([
		"   x    ",
	]);
});

test("narrow adapters match installed host shell source and real Box geometry", () => {
	const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
	// ponytail: validate only shell geometry, not host lifecycle, images, mouse input, or whole-screen painting.
	const host = readFileSync(
		new URL("./modes/interactive/components/tool-execution.js", entry),
		"utf8",
	);
	expect(host).toContain("new Box(1, 1,");
	expect(host).toMatch(/lines\.push\(""\);\s*lines\.push\(\.\.\.contentLines\);/);
	for (const width of [3, 80]) {
		const text = new Text("x".repeat(81), 0, 0);
		const box = new Box(1, 1);
		box.addChild(text);
		expect(captureRows(text, { width, surface: "host-box" })).toEqual([
			"",
			...box.render(width).map(semanticRow),
		]);
		expect(captureRows(text, { width, surface: "host-self" })).toEqual([
			"",
			...text.render(width).map(semanticRow),
		]);
	}
	expect(captureRows(new Text("", 0, 0), { width: 80, surface: "host-self" })).toEqual([]);
});

test("fixture restores singleton, env, icons, columns and resize after failed assertions", async () => {
	const key = Symbol.for("@xynogen/pix-runtime");
	const globals = globalThis as unknown as Record<symbol, unknown>;
	const previous = globals[key];
	const icons = getIconMode();
	const env = process.env.PRETTY_MAX_PREVIEW_LINES;
	const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	let resized = 0;
	const listener = () => resized++;
	process.stdout.on("resize", listener);
	try {
		const fixture = await withUiFixture();
		try {
			fixture.setWidth(120);
			expect(process.stdout.columns).toBe(120);
			expect(getIconMode()).toBe("unicode");
			throw new Error("assertion failed");
		} catch (error) {
			expect((error as Error).message).toBe("assertion failed");
		} finally {
			await fixture.restore();
		}
		expect(globals[key]).toBe(previous);
		expect(getIconMode()).toBe(icons);
		expect(process.env.PRETTY_MAX_PREVIEW_LINES).toBe(env);
		expect(Object.getOwnPropertyDescriptor(process.stdout, "columns")).toEqual(columns);
		expect(resized).toBe(3);
	} finally {
		process.stdout.removeListener("resize", listener);
	}
});

test("fixture restores globals after startup and shutdown failures", async () => {
	const key = Symbol.for("@xynogen/pix-runtime");
	const globals = globalThis as unknown as Record<symbol, unknown>;
	const previous = globals[key];
	for (const phase of ["init", "shutdown"] as const) {
		const isolated = testing.createIsolatedRuntime();
		const factory = spyOn(testing, "createIsolatedRuntime").mockReturnValue(isolated);
		const failure = spyOn(isolated.runtime, phase).mockRejectedValue(new Error(phase));
		try {
			if (phase === "init") await expect(withUiFixture()).rejects.toThrow("init");
			else {
				const fixture = await withUiFixture();
				await expect(fixture.restore()).rejects.toThrow("shutdown");
			}
			expect(globals[key]).toBe(previous);
		} finally {
			failure.mockRestore();
			factory.mockRestore();
			await isolated.runtime.shutdown();
			isolated.cleanup();
		}
	}
});

test("display syntax regression supplies the checked raw string color", () => {
	const source = readFileSync(
		new URL("../packages/pix-display/test/code-blocks.test.ts", import.meta.url),
		"utf8",
	);
	expect(source).toContain("const highlighted = '\\x1b[38;2;206;145;120m\"TOKEN\"\\x1b[39m'");
	expect(semanticRow('\x1b[38;2;206;145;120m"TOKEN"\x1b[39m')).toBe(
		'<raw.string>"TOKEN"</raw.string>',
	);
});

const hostThemeKeys = [
	Symbol.for("@earendil-works/pi-coding-agent:theme"),
	Symbol.for("@mariozechner/pi-coding-agent:theme"),
];

test("opt-in fixture checks installed host reads and real Markdown semantic roles", async () => {
	expect(VERSION).toBe("0.99.2");
	const source = readFileSync(
		new URL(
			"./modes/interactive/theme/theme.js",
			import.meta.resolve("@earendil-works/pi-coding-agent"),
		),
		"utf8",
	);
	expect(source).toContain("const t = globalThis[THEME_KEY]");
	for (const key of [
		"@earendil-works/pi-coding-agent:theme",
		"@mariozechner/pi-coding-agent:theme",
	])
		expect(source).toContain(`Symbol.for("${key}")`);
	const fixture = await withUiFixture({ hostTheme: true });
	try {
		const markdown = getMarkdownTheme();
		for (const [accessor, role] of [
			["heading", "mdHeading"],
			["link", "mdLink"],
			["linkUrl", "mdLinkUrl"],
			["code", "mdCode"],
			["codeBlock", "mdCodeBlock"],
			["codeBlockBorder", "mdCodeBlockBorder"],
			["quote", "mdQuote"],
			["quoteBorder", "mdQuoteBorder"],
			["hr", "mdHr"],
			["listBullet", "mdListBullet"],
		] as const)
			expect(semanticRow(markdown[accessor]("x"))).toBe(`<${role}>x</${role}>`);
		for (const accessor of ["bold", "italic", "underline", "strikethrough"] as const)
			expect(semanticRow(markdown[accessor]("x"))).toBe(`<${accessor}>x</${accessor}>`);
		const component = new Markdown(
			'# Heading\n\ntext and `code`\n\n> quote\n\n- item\n\n~~strike~~\n\n---\n\n```ts\nconst value = "text";\n```',
			0,
			0,
			markdown,
		);
		const raw = component.render(32);
		expect(raw.every((row) => visibleWidth(row) <= 32)).toBe(true);
		const rows = captureRows(component, { width: 32, surface: "component" });
		expect(rows).toEqual(raw.map(semanticRow));
		expect(() =>
			captureRows(new Markdown("[link](https://example.com)", 0, 0, markdown), {
				width: 32,
				surface: "component",
				osc133: true,
			}),
		).toThrow("Unsupported fixture escape or control");
		const rendered = rows.join("\n");
		for (const role of [
			"mdHeading",
			"mdCode",
			"mdQuote",
			"mdListBullet",
			"mdHr",
			"mdCodeBlockBorder",
			"syntaxKeyword",
			"syntaxString",
		])
			expect(rendered).toContain(`<${role}`);
		expect(rendered).toContain("<strikethrough>");
		const custom = new CustomMessageComponent({
			role: "custom",
			customType: "BTW",
			content: "answer `code`",
			display: true,
			timestamp: 0,
		});
		const customRows = captureRows(custom, { width: 32, surface: "component" }).join("\n");
		for (const role of ["customMessageText", "customMessageLabel", "bg:customMessageBg", "mdCode"])
			expect(customRows).toContain(role);
	} finally {
		await fixture.restore();
	}
});

test("native assistant boundaries stay zero-width until decoding", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	try {
		const component = new AssistantMessageComponent({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reason" },
				{ type: "text", text: "# Answer" },
			],
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		});
		const raw = component.render(16);
		expect(raw[0]).toBe("\x1b]133;A\x07");
		expect(raw.at(-1)).toMatch(/^\x1b\]133;B\x07\x1b\]133;C\x07/);
		expect(() => captureRows(component, { width: 16, surface: "component" })).toThrow();
		const rows = captureRows(component, { width: 16, surface: "component", osc133: true });
		expect(rows[0]).toBe("<osc133:A/>");
		expect(rows.at(-1)).toMatch(/^<osc133:B\/><osc133:C\/>/);
		expect(rows.join("\n")).toContain("<thinkingText+italic>");
		expect(rows.join("\n")).toContain("<mdHeading+bold+underline>");
		expect(rows).toEqual(raw.map((row) => semanticRow(row, { osc133: true })));
	} finally {
		await fixture.restore();
	}
	for (const value of [
		"\x1b]133;D\x07",
		"\x1b]133;A;extra\x07",
		"\x1b]133;A\x1b\\",
		"\x1b]8;;url\x07",
		"\x1b]0;title\x07",
	])
		expect(() => semanticRow(value, { osc133: true })).toThrow();
	for (const rows of [
		["\x1b]133;A\x07x"],
		["x\x1b]133;A\x07", "\x1b]133;B\x07\x1b]133;C\x07"],
		["\x1b]133;A\x07", "\x1b]133;C\x07\x1b]133;B\x07"],
	])
		expect(() =>
			captureRows({ render: () => rows }, { width: 16, surface: "component", osc133: true }),
		).toThrow();
});

test("host symbols restore exact absent and existing descriptors after failures", async () => {
	const saved = hostThemeKeys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
	try {
		for (const existing of [false, true, undefined]) {
			for (const key of hostThemeKeys) {
				if (existing !== false)
					Object.defineProperty(globalThis, key, {
						configurable: true,
						enumerable: false,
						writable: true,
						value: existing ? { name: "previous theme" } : undefined,
					});
				else Reflect.deleteProperty(globalThis, key);
			}
			const before = hostThemeKeys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
			const plain = await withUiFixture();
			try {
				expect(
					hostThemeKeys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key)),
				).toEqual(before);
			} finally {
				await plain.restore();
			}
			const fixture = await withUiFixture({ hostTheme: true });
			try {
				for (const key of hostThemeKeys)
					expect(Reflect.get(globalThis, key).fg("mdHeading", "x")).toBe(
						theme.fg("mdHeading", "x"),
					);
				throw new Error("assertion failed");
			} catch (error) {
				expect((error as Error).message).toBe("assertion failed");
			} finally {
				await fixture.restore();
			}
			expect(hostThemeKeys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key))).toEqual(
				before,
			);
			const isolated = testing.createIsolatedRuntime();
			const factory = spyOn(testing, "createIsolatedRuntime").mockReturnValue(isolated);
			const failure = spyOn(isolated.runtime, "init").mockRejectedValue(new Error("init"));
			try {
				await expect(withUiFixture({ hostTheme: true })).rejects.toThrow("init");
				expect(
					hostThemeKeys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key)),
				).toEqual(before);
			} finally {
				failure.mockRestore();
				factory.mockRestore();
				await isolated.runtime.shutdown();
				isolated.cleanup();
			}
			const shutdownFixture = await withUiFixture({ hostTheme: true });
			const shutdownFailure = spyOn(shutdownFixture.runtime, "shutdown").mockRejectedValue(
				new Error("shutdown"),
			);
			try {
				await expect(shutdownFixture.restore()).rejects.toThrow("shutdown");
				expect(
					hostThemeKeys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key)),
				).toEqual(before);
			} finally {
				shutdownFailure.mockRestore();
				await shutdownFixture.runtime.shutdown();
			}
		}
	} finally {
		for (const [index, key] of hostThemeKeys.entries()) {
			const descriptor = saved[index];
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
