import { expect, test } from "bun:test";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type EditorComponent,
	type EditorTheme,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { dirIcon, fileIcon } from "@xynogen/pix-pretty/icons";
import installInlineChips, {
	expandChips,
	installChips,
	renderChips,
	renderHistoryChips,
} from "../src/inline-chips.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, "");

function editor(): CustomEditor {
	const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;
	const theme = { borderColor: (t: string) => t, selectList: {} } as EditorTheme;
	const e = new CustomEditor(tui, theme, { matches: () => false } as unknown as KeybindingsManager);
	installChips(e);
	return e;
}

type Entry = string | { kind: "image" | "path"; path: string };
type Reg = Map<number, Entry>;

test("renderChips: text, image and path chips", () => {
	const registry: Reg = new Map<number, Entry>([
		[1, "x".repeat(2232)],
		[2, Array(42).fill("l").join("\n")],
		[3, { kind: "image", path: "/tmp/a.png" }],
		[4, { kind: "path", path: "src/index.ts" }],
		[5, { kind: "path", path: "pkg/dir/" }],
		[6, { kind: "path", path: "/" }],
	]);
	const line =
		"a [paste #1 2232 chars] b [paste #2 +42 lines] c [paste #3 10 chars] [paste #4 12 chars] [paste #5 8 chars] [paste #6 1 chars] <path>raw</path>";
	expect(strip(renderChips(line, registry))).toBe(
		`a ${icon("paste.text")} text 2.2k chars b ${icon("paste.text")} text 42 lines c ${icon("paste.image")} image #3 ${fileIcon("src/index.ts")}@index.ts ${dirIcon()}@dir/ ${dirIcon()}@/ <path>raw</path>`,
	);
	expect(renderChips("[paste #9]", registry)).toBe("[paste #9]");
	expect(renderChips("plain", registry)).toBe("plain");
});

test("renderChips keeps the cursor inside a chip", () => {
	const registry: Reg = new Map<number, Entry>([
		[1, "abc"],
		[2, { kind: "path", path: "a/b.ts" }],
	]);
	const out = renderChips(`[paste #1 ${CURSOR_MARKER}\x1b[7m3\x1b[0m chars]`, registry);
	expect(out.startsWith(CURSOR_MARKER)).toBe(true);
	expect(out).toContain("\x1b[7m");
	const path = renderChips(`[paste #2 ${CURSOR_MARKER}\x1b[7m6\x1b[0m chars]`, registry);
	expect(strip(path)).toBe(`${fileIcon("a/b.ts")}@b.ts`);
	expect(path).toContain(CURSOR_MARKER);
});

test("expandChips wraps each blob once; path chips expand to <path>", () => {
	const registry: Reg = new Map<number, Entry>([
		[1, "[paste #2 3 chars]"],
		[2, { kind: "image", path: "/tmp/a.png" }],
		[3, { kind: "path", path: "x" }],
	]);
	expect(expandChips("[paste #1 18 chars] [paste #2 10 chars] [paste #3 1 chars]", registry)).toBe(
		"<paste>[paste #2 3 chars]</paste> <paste>/tmp/a.png</paste> <path>x</path>",
	);
	expect(expandChips("[paste #7]", registry)).toBe("[paste #7]");
});

test("renderHistoryChips collapses sent-message tags into inline-code chips", () => {
	const short = "hello   world";
	const long = `${"a".repeat(30)} middle ${"z".repeat(30)}`;
	const md = `see <paste>${short}</paste> and <paste>${long}</paste> <paste>/tmp/a.png</paste> <path>src/x.ts</path> <path>pkg/</path> plain <paste>a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk</paste>`;
	const out = renderHistoryChips(md);
	expect(out).toContain(`\`${icon("paste.text")} text 13 chars · hello world\``);
	const longChip = /`[^`]*68 chars · ([^`]*)`/.exec(out)?.[1] ?? "";
	expect(longChip).toStartWith("a".repeat(26));
	expect(longChip).toEndWith("z".repeat(13));
	expect(longChip).toContain("…");
	expect(longChip.length).toBeLessThanOrEqual(41);
	expect(out).toContain(`\`${icon("paste.image")} image\``);
	expect(out).toContain(`\`${fileIcon("src/x.ts")}@x.ts\``);
	expect(out).toContain(`\`${dirIcon()}@pkg/\``);
	expect(out).toContain("11 lines · a b c d e f g h i j k");
	expect(out).toContain(" plain ");
	expect(out).not.toContain("<paste>");
	expect(out).not.toContain("<path>");
	expect(renderHistoryChips("no tags `code`")).toBe("no tags `code`");
	expect(renderHistoryChips("<paste>has ` tick</paste>")).not.toContain("` tick");
});

test("installChips: paste, image path and <path> round-trip on a real editor", () => {
	const e = editor();
	const big = "x".repeat(1001);
	e.handleInput(`\x1b[200~${big}\x1b[201~`);
	expect(e.getExpandedText()).toBe(`<paste>${big}</paste> `);
	e.insertTextAtCursor("see /tmp/shot.png now");
	expect(e.getText()).toMatch(/see \[paste #2 13 chars\] now$/);
	expect(e.getExpandedText()).toContain("<paste>/tmp/shot.png</paste>");
	e.insertTextAtCursor("/tmp/b.png");
	expect(e.getText()).toEndWith("[paste #3 10 chars] ");
	e.insertTextAtCursor("<path>src/a b.ts</path> ");
	expect(e.getText()).toEndWith("[paste #4 10 chars] ");
	expect(e.getExpandedText()).toEndWith("<path>src/a b.ts</path> ");
	const rendered = e.render(100).join("\n");
	expect(rendered).toContain("@a b.ts");
	expect(rendered).toContain("image");
	expect(rendered).not.toContain("<path>");
	for (const width of [10, 20, 40, 100]) {
		expect(e.render(width).every((l) => visibleWidth(l) <= width)).toBe(true);
	}
	e.insertTextAtCursor("");
	// Two backspaces: the trailing space, then the whole chip.
	e.handleInput("\x7f");
	e.handleInput("\x7f");
	expect(e.getText()).toEndWith("[paste #3 10 chars] ");
	expect(e.getExpandedText()).not.toContain("<path>");
});

test.each(["tui", "rpc"] as const)("lifecycle in %s mode chains a previous factory", (mode) => {
	type Factory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let transformer: ((md: string, ctx: { messageType: string }) => string) | undefined;
	installInlineChips({
		on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => void) =>
			handlers.set(name, fn),
		registerMarkdownTransformer: (fn: typeof transformer) => {
			transformer = fn;
		},
	} as unknown as ExtensionAPI);
	expect(transformer!("<path>a.ts</path>", { messageType: "user" })).toContain("@a.ts");
	expect(transformer!("<path>a.ts</path>", { messageType: "assistant" })).toBe("<path>a.ts</path>");
	const foreign = { render: () => ["foreign"] } as unknown as EditorComponent;
	let factory: Factory | undefined = () => foreign;
	let sets = 0;
	const ctx = {
		mode,
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent: (next: Factory | undefined) => {
				factory = next;
				sets++;
			},
		},
	} as unknown as ExtensionContext;
	handlers.get("session_start")!({}, ctx);
	if (mode === "tui") {
		// Foreign editors are kept as-is (no CustomEditor internals to patch).
		expect(factory!(...([] as unknown as Parameters<Factory>))).toBe(foreign);
		factory = undefined;
		handlers.get("session_start")!({}, ctx);
		const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;
		const fresh = factory!(
			tui,
			{ borderColor: (t: string) => t, selectList: {} } as EditorTheme,
			{
				matches: () => false,
			} as unknown as KeybindingsManager,
		) as CustomEditor;
		expect(fresh).toBeInstanceOf(CustomEditor);
		fresh.insertTextAtCursor("<path>x.ts</path>");
		expect(fresh.render(40).join("")).toContain("@x.ts");
	}
	handlers.get("session_shutdown")!({}, ctx);
	expect(sets).toBe(mode === "tui" ? 3 : 0);
});
