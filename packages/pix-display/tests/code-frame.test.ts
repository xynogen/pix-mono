import { describe, expect, it } from "bun:test";
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { renderCodeFences } from "../src/code-blocks.js";
import {
	COPY_BUTTON,
	type CodeFrame,
	frameClickAt,
	initCodeFrames,
	rememberFrames,
	setCodeFramesExpanded,
} from "../src/code-frame.js";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const plain = (line: string) => line.replace(ANSI_RE, "");

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Parameters<typeof renderCodeFences>[2];

const click = (x: number, y: number, width: number) =>
	({ type: "click", button: "left", x, y, width }) as Parameters<typeof frameClickAt>[1];

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

describe("code frame header", () => {
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
		initCodeFrames(ui, (text) => {
			written.push(text);
			return Promise.resolve();
		});
		const owner = {};
		rememberFrames(owner, [{ row: 2, text: "a\nb" }]);
		const width = 40;

		expect(frameClickAt(owner, click(width - COPY_BUTTON.length, 2, width))).toBe(true);
		expect(written).toEqual(["a\nb"]);
		expect(frameClickAt(owner, click(width - COPY_BUTTON.length - 1, 2, width))).toBe(false);
		expect(frameClickAt(owner, click(width - 1, 1, width))).toBe(false);
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
			initCodeFrames(fakeUi(), (text) => {
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

	it("folds a block from its arrow and reopens it", () => {
		const lines = ["```ts", "const a = 1;", "const b = 2;", "```"];
		const width = 40;
		const frames: CodeFrame[] = [];
		const open = renderCodeFences(lines, width, theme, frames).map(plain);
		expect(open[0]).toStartWith("▾ ts ");

		let invalidated = 0;
		const owner = { invalidate: () => invalidated++ };
		rememberFrames(owner, frames);
		expect(frameClickAt(owner, click(0, 0, width))).toBe(true);
		expect(invalidated).toBe(1);

		const closedFrames: CodeFrame[] = [];
		const closed = renderCodeFences(lines, width, theme, closedFrames).map(plain);
		expect(closed).toHaveLength(1);
		expect(closed[0]).toStartWith("▸ ts · 2 lines ");
		expect(closed[0]).toEndWith(COPY_BUTTON);
		expect(visibleWidth(closed[0] ?? "")).toBe(width);
		expect(closedFrames).toEqual([{ row: 0, text: "const a = 1;\nconst b = 2;" }]);

		// Pi's expand key opens every block again.
		expect(setCodeFramesExpanded(true)).toBe(true);
		expect(renderCodeFences(lines, width, theme)).toHaveLength(open.length);
	});
});
