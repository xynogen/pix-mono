import { describe, expect, it } from "bun:test";
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { renderCodeFences } from "../src/code-blocks.js";
import {
	COPY_BUTTON,
	type CodeFrame,
	copyCodeAt,
	initCodeCopy,
	rememberFrames,
} from "../src/code-copy.js";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const plain = (line: string) => line.replace(ANSI_RE, "");

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Parameters<typeof renderCodeFences>[2];

const click = (x: number, y: number, width: number) =>
	({ type: "click", button: "left", x, y, width }) as Parameters<typeof copyCodeAt>[1];

function fakeUi() {
	const shown: string[] = [];
	return {
		shown,
		setWidget: (_key: string, content: unknown) => {
			if (content) shown.push("shown");
			else shown.push("cleared");
		},
	};
}

describe("code frame copy button", () => {
	it("draws the button at the far right without widening the row", () => {
		const [header] = renderCodeFences(["```ts", "const a = 1;", "```"], 40, theme);
		const text = plain(header ?? "");
		expect(text).toEndWith(COPY_BUTTON);
		expect(visibleWidth(text)).toBe(40);
	});

	it("reports each frame's header row and its source without the fence", () => {
		const frames: CodeFrame[] = [];
		renderCodeFences(["```py", "  if x:", "      y()", "```"], 40, theme, frames);
		expect(frames).toEqual([{ row: 0, text: "if x:\n    y()" }]);
	});

	it("copies on a click inside the button and ignores the rest of the row", () => {
		const ui = fakeUi();
		const written: string[] = [];
		initCodeCopy(ui, (text) => {
			written.push(text);
			return Promise.resolve();
		});
		const owner = {};
		rememberFrames(owner, [{ row: 2, text: "a\nb" }]);
		const width = 40;

		expect(copyCodeAt(owner, click(width - COPY_BUTTON.length, 2, width))).toBe(true);
		expect(written).toEqual(["a\nb"]);
		expect(copyCodeAt(owner, click(width - COPY_BUTTON.length - 1, 2, width))).toBe(false);
		expect(copyCodeAt(owner, click(width - 1, 1, width))).toBe(false);
		expect(written).toEqual(["a\nb"]);
	});

	it("copies the block whose header the user clicked in a rendered message", async () => {
		const { AssistantMessageComponent, getMarkdownTheme } = await import(
			"@earendil-works/pi-coding-agent"
		);
		const { default: codeBlocksExtension } = await import("../src/code-blocks.js");
		const { followFoldInput } = await import("../src/fold.js");
		const { roleTheme, withUiFixture } = await import("../../../scripts/ui-capture.ts");
		const fixture = await withUiFixture({ hostTheme: true });
		const hooks = new Map<string, (event: unknown, ctx: unknown) => void>();
		const pi = { on: (name: string, hook: never) => hooks.set(name, hook) };
		try {
			codeBlocksExtension(pi as never);
			followFoldInput();
			hooks.get("session_start")?.({}, { mode: "tui", ui: { theme: roleTheme() } });

			const written: string[] = [];
			initCodeCopy(fakeUi(), (text) => {
				written.push(text);
				return Promise.resolve();
			});
			const width = 60;
			const message = {
				role: "assistant",
				content: [{ type: "text", text: "```ts\nconst a = 1;\n```\n\n```py\nprint(2)\n```" }],
				api: "openai-completions",
				provider: "fixture",
				model: "capture",
				stopReason: "stop",
				timestamp: 0,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as never;
			const component = new AssistantMessageComponent(message, false, getMarkdownTheme());
			const rows = component.render(width);
			const headers = rows.flatMap((row, y) => (plain(row).endsWith(COPY_BUTTON) ? [y] : []));
			expect(headers).toHaveLength(2);

			const at = (y: number, x: number): TuiMouseEvent => ({
				type: "click",
				button: "left",
				x,
				y,
				screenX: x,
				screenY: y,
				width,
				height: rows.length,
				shift: false,
				alt: false,
				ctrl: false,
			});
			// Second frame's button: the row map must survive the first frame above it.
			component.handleMouse?.(at(headers[1] ?? 0, width - 1));
			expect(written).toEqual(["print(2)"]);
		} finally {
			await fixture.restore();
		}
	});
});
