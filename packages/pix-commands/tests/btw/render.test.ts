import { describe, expect, test } from "bun:test";
import { type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";
import { setMarkdownTransform } from "@xynogen/pix-pretty/markdown-transform";
import { type BtwMessageDetails, registerBtwRenderer } from "../../src/btw/render.ts";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function captureRenderer() {
	let renderer: ((entry: unknown, options: unknown, theme: unknown) => unknown) | undefined;
	const pi = {
		registerEntryRenderer(_name: string, fn: typeof renderer) {
			renderer = fn;
		},
	} as unknown as ExtensionAPI;
	registerBtwRenderer(pi);
	if (!renderer) throw new Error("renderer was not registered");
	return renderer;
}

const backgrounds: string[] = [];
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (color: string, text: string) => {
		backgrounds.push(color);
		return text;
	},
	bold: (text: string) => text,
};

function render(details: BtwMessageDetails, expanded = false): string {
	const renderer = captureRenderer();
	const component = renderer(
		{ type: "custom", customType: "pix-btw-answer", data: details },
		{ expanded },
		theme,
	) as {
		render(width: number): readonly string[];
	};
	return stripAnsi(component.render(80).join("\n"));
}

describe("BTW renderer", () => {
	test("renders metadata and question as distinct side-thread card chrome", () => {
		backgrounds.length = 0;
		const output = render({
			question: "hello",
			answer: "Hi!",
			thinking: "",
			model: "GPT-5.6",
			thinkingLevel: "high",
			durationMs: 2_100,
			toolUses: 0,
		});
		expect(output).toContain("✓ BTW · GPT-5.6 · high · 2.1s");
		expect(output).toContain("▐ hello");
		expect(output).not.toContain("SIDE THREAD");
		expect(backgrounds).toContain("selectedBg");
		expect(backgrounds).not.toContain("customMessageBg");
	});

	test("renders the answer as Markdown", () => {
		initTheme();
		const output = render({
			question: "show markdown",
			answer: "## Heading\n\n- alpha\n- beta\n\n`code`",
			thinking: "",
			model: "Model",
			thinkingLevel: "medium",
			durationMs: 1_000,
			toolUses: 1,
		});
		expect(output).toContain("Heading");
		expect(output).toContain("alpha");
		expect(output).toContain("beta");
		expect(output).toContain("code");
	});

	test("passes the answer through the shared display transform", () => {
		initTheme();
		setMarkdownTransform((markdown) => markdown.replace("::card[3]", "CARD-3"));
		try {
			const output = render({
				question: "q",
				answer: "::card[3]",
				thinking: "",
				model: "Model",
				thinkingLevel: "low",
				durationMs: 1_000,
				toolUses: 0,
			});
			expect(output).toContain("CARD-3");
		} finally {
			setMarkdownTransform(undefined);
		}
	});

	test("hides reasoning by default and reveals it when expanded", () => {
		initTheme();
		const details: BtwMessageDetails = {
			question: "why",
			answer: "Because.",
			thinking: "first I considered the mutex",
			model: "Model",
			thinkingLevel: "high",
			durationMs: 1_000,
			toolUses: 0,
		};
		const collapsed = render(details, false);
		expect(collapsed).toContain("reasoning hidden");
		expect(collapsed).not.toContain("first I considered the mutex");

		const expanded = render(details, true);
		expect(expanded).toContain("Reasoning");
		expect(expanded).toContain("first I considered the mutex");
	});
});
