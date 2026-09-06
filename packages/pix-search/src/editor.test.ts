import { expect, test } from "bun:test";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type EditorComponent,
	type EditorTheme,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { dirIcon, fileIcon } from "@xynogen/pix-pretty/icons";
import { atStartsMention, attachPicker, pathToken } from "./editor.ts";
import registerSearch from "./extension.ts";

test.each([
	false,
	true,
])("search/display composition preserves chips (search first: %s)", async (searchFirst) => {
	type Factory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
	const starts: ((event: unknown, ctx: ExtensionContext) => unknown)[] = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			if (event === "session_start") starts.push(handler);
		},
	} as unknown as ExtensionAPI;
	let factory: Factory | undefined;
	let picks = 0;
	let selection = "src/index.ts";
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: import.meta.dir,
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent: (next: Factory) => {
				factory = next;
			},
			custom: async () => {
				picks++;
				return selection;
			},
		},
	} as unknown as ExtensionContext;
	// Load the sibling extension at runtime; it is not a pix-search dependency.
	const { default: registerInlineChips } = await import(
		new URL("../../pix-display/src/inline-chips.ts", import.meta.url).href
	);
	for (const register of searchFirst
		? [registerSearch, registerInlineChips]
		: [registerInlineChips, registerSearch])
		register(pi);
	for (const start of starts) await start({}, ctx);
	const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;
	const theme = { borderColor: (text: string) => text, selectList: {} } as EditorTheme;
	const editor: EditorComponent = factory!(tui, theme, {
		matches: () => false,
	} as unknown as KeybindingsManager);
	expect(editor).toBeInstanceOf(CustomEditor);
	const pasted = "x".repeat(1001);
	editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
	expect(editor.getExpandedText?.()).toBe(`<paste>${pasted}</paste> `);
	expect(editor.render(100).join("\n")).toContain("text");
	editor.handleInput("@");
	await Promise.resolve();
	expect(picks).toBe(1);
	expect(editor.getExpandedText?.()).toBe(`<paste>${pasted}</paste> <path>src/index.ts</path> `);
	let rendered = editor.render(100).join("\n");
	expect(rendered).toContain(`${fileIcon("src/index.ts")}@index.ts`);
	expect(rendered).not.toContain("<path>");
	expect(rendered).toContain(icon("paste.text"));
	selection = "packages/my folder/";
	editor.handleInput("@");
	await Promise.resolve();
	expect(editor.getExpandedText?.()).toEndWith("<path>packages/my folder/</path> ");
	rendered = editor.render(100).join("\n");
	expect(rendered).toContain(`${dirIcon()}@my folder/`);
	for (const width of [10, 20, 40, 100]) {
		expect(editor.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	}
	editor.insertTextAtCursor?.("@typed/path.ts ");
	expect(editor.getText()).toContain("@typed/path.ts ");
	editor.insertTextAtCursor?.("/tmp/image.png");
	expect(editor.getExpandedText?.()).toContain("<paste>/tmp/image.png</paste>");
	editor.handleInput("\x1b[200~");
	editor.handleInput("@");
	editor.handleInput("\x1b[201~");
	await Promise.resolve();
	expect(picks).toBe(2);
	expect(editor.getExpandedText?.()).toEndWith(" @");
});

test("search alone inserts a plain <path> token", async () => {
	const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;
	const theme = { borderColor: (text: string) => text, selectList: {} } as EditorTheme;
	const editor = new CustomEditor(tui, theme, {
		matches: () => false,
	} as unknown as KeybindingsManager);
	attachPicker(
		editor,
		tui,
		async () => "a b/c.ts",
		() => {},
	);
	editor.handleInput("@");
	await Promise.resolve();
	expect(editor.getText()).toBe(pathToken("a b/c.ts"));
	expect(editor.render(60).join("")).toContain("<path>a b/c.ts</path>");
});

test("picker cancellation and failure keep the typed @", async () => {
	const errors: string[] = [];
	let renders = 0;
	const tui = {
		requestRender: () => {
			renders++;
		},
	} as unknown as TUI;
	const theme = { borderColor: (text: string) => text, selectList: {} } as EditorTheme;
	const editor = new CustomEditor(tui, theme, {
		matches: () => false,
	} as unknown as KeybindingsManager);
	let fail = false;
	attachPicker(
		editor,
		tui,
		async () => {
			if (fail) throw new Error("picker unavailable");
			return null;
		},
		(message) => errors.push(message),
	);
	editor.handleInput("@");
	await Promise.resolve();
	expect(editor.getText()).toBe("@");
	fail = true;
	editor.insertTextAtCursor(" ");
	editor.handleInput("@");
	await Promise.resolve();
	expect(editor.getText()).toBe("@ @");
	expect(errors).toEqual(["File picker failed: picker unavailable"]);
	expect(renders).toBeGreaterThanOrEqual(2);
});

test("@ at line start begins a mention", () => {
	expect(atStartsMention("")).toBe(true);
});

test("@ after a space begins a mention", () => {
	expect(atStartsMention("look at ")).toBe(true);
});

test("@ after a newline-adjacent tab begins a mention", () => {
	expect(atStartsMention("foo\t")).toBe(true);
});

test("@ mid-word (e.g. email) does not begin a mention", () => {
	expect(atStartsMention("me")).toBe(false);
	expect(atStartsMention("user@")).toBe(false);
});
