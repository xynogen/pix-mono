import { afterEach, describe, expect, test } from "bun:test";
import {
	filterChoices,
	type ProviderPickerOptions,
	type ProviderPickerUI,
	renderProviderRows,
	renderSettingsRows,
	showSettingsPicker,
} from "../src/provider-picker.ts";

// Tag every color role so assertions check the semantic theme role, not ANSI bytes.
const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>` };
const saved = { ...process.env };

afterEach(() => {
	process.env = { ...saved };
});

function options(): ProviderPickerOptions {
	return {
		title: "Voice",
		subtitle: "providers",
		current: "openai",
		envAliases: { NINEROUTER_KEY: "ROUTER_API_KEY" },
		rows: [
			{ id: "auto", configured: true, env: [] },
			{ id: "openai", configured: true, env: ["OPENAI_API_KEY"], model: "whisper-1" },
			{ id: "deepgram", configured: false, env: ["DEEPGRAM_API_KEY"] },
			{ id: "local", configured: true, env: [], noKey: true },
		],
	};
}

/** Drive showSettingsPicker with key presses. Returns the result and the last frame. */
function harness() {
	let component:
		| { render(width: number): readonly string[]; handleInput(data: string): void }
		| undefined;
	const ui: ProviderPickerUI = {
		custom: (factory) =>
			new Promise((resolve) => {
				component = factory(
					{ requestRender() {} },
					{ ...theme, bg: (_role: string, text: string) => text, bold: (text: string) => text },
					{
						matches: (data: string, id: string) =>
							id === "tui.select.cancel"
								? data === "\x1b"
								: id === "tui.select.down"
									? data === "\x1b[B"
									: false,
					} as never,
					resolve,
				);
			}),
	};
	return {
		ui,
		press: (data: string) => component?.handleInput(data),
		frame: () => component?.render(80).join("\n") ?? "",
	};
}

describe("settings overview modal", () => {
	test("stays open after a row action and shows the new value and status", async () => {
		let play = false;
		const h = harness();
		const result = showSettingsPicker(h.ui, {
			title: "Voice",
			rows: () => [{ key: "play", section: "TTS", label: "play", value: play ? "on" : "off" }],
			status: () => ["meter ██░░"],
			onAction: () => {
				play = !play;
				return undefined;
			},
		});
		h.press("\r");
		await Bun.sleep(0);
		expect(h.frame()).toMatch(/play.*<success>on<\/success>[\s\S]*meter ██░░/);
		h.press("\x1b");
		expect(await result).toBeNull();
	});

	test("picks a value from the in-modal list, filtered by typing", async () => {
		let language = "auto";
		const h = harness();
		const result = showSettingsPicker(h.ui, {
			title: "Voice",
			rows: () => [
				{
					key: "stt:language",
					section: "STT",
					label: "language",
					value: language,
					editable: true,
					choices: [
						{ value: "auto", hint: "detect" },
						{ value: "en", hint: "English" },
						{ value: "id", hint: "Indonesian" },
					],
				},
			],
			onAction: ({ value }) => {
				language = value ?? language;
				return undefined;
			},
		});
		h.press("\r");
		for (const char of "indo") h.press(char);
		// Only "id" and the custom item match "indo". The cursor is on "id".
		const frame = h.frame().replace(/<\/?[a-z]+>|[│╭╮╰╯─]/g, "");
		expect(frame).toMatch(/filter: indo█\s+▸ id\s+Indonesian\s+type a value…/);
		h.press("\r");
		await Bun.sleep(0);
		expect(language).toBe("id");
		expect(h.frame()).toMatch(/language.*<success>id<\/success>/);
		h.press("\x1b");
		expect(await result).toBeNull();
	});

	test("space acts like enter, and ←→ step through choices (standard /pix keys)", async () => {
		let play = false;
		let language = "auto";
		const h = harness();
		const result = showSettingsPicker(h.ui, {
			title: "Voice",
			rows: () => [
				{ key: "play", section: "", label: "play", value: play ? "on" : "off" },
				{
					key: "lang",
					section: "",
					label: "language",
					value: language,
					choices: [{ value: "auto" }, { value: "en" }, { value: "id" }],
				},
			],
			onAction: ({ key, value }) => {
				if (key === "play") play = !play;
				else language = value ?? language;
				return undefined;
			},
		});
		expect(h.frame()).toContain("space/enter/←→ change");
		h.press(" ");
		await Bun.sleep(0);
		expect(play).toBe(true);
		h.press("\x1b[B");
		h.press("\x1b[D");
		await Bun.sleep(0);
		expect(language).toBe("id");
		h.press("\x1b[C");
		await Bun.sleep(0);
		expect(language).toBe("auto");
		h.press("\x1b");
		expect(await result).toBeNull();
	});

	test("closes with the action only when onAction returns close", async () => {
		const h = harness();
		const result = showSettingsPicker(h.ui, {
			title: "Web",
			rows: () => [{ key: "search:provider", section: "Search", label: "provider", value: "exa" }],
			onAction: () => "close",
		});
		h.press("\r");
		expect(await result).toEqual({ key: "search:provider" });
	});

	test("sectionTabs shows one section per sub-tab; ` switches and keeps the place after an action", async () => {
		const on = new Set<string>();
		const h = harness();
		const rows = () => [
			{ key: "a1", section: "Core", label: "alpha", value: on.has("a1") ? "on" : "off" },
			{ key: "a2", section: "Core", label: "beta", value: "off" },
			{ key: "b1", section: "Packages", label: "gamma", value: on.has("b1") ? "on" : "off" },
		];
		const result = showSettingsPicker(h.ui, {
			title: "Extensions",
			rows,
			sectionTabs: true,
			onAction: ({ key }) => {
				on.add(key);
				return undefined;
			},
		});
		const plain = () => h.frame().replace(/<\/?[a-z]+>/g, "");
		expect(plain()).toMatch(/● Core {3}○ Packages/);
		expect(plain()).toContain("alpha");
		expect(plain()).not.toContain("gamma");
		expect(plain()).toContain("` sub-tab");
		h.press("`");
		expect(plain()).toContain("gamma");
		expect(plain()).not.toContain("alpha");
		h.press("\r");
		await Bun.sleep(0);
		// Still on Packages after the action; the cursor row shows the new value.
		expect(plain()).toMatch(/→ gamma\s+on/);
		h.press("`");
		expect(plain()).toMatch(/→ alpha\s+off/);
		h.press("\x1b");
		expect(await result).toBeNull();
	});

	test("sectionTabs with one section shows no tab bar and ignores `", async () => {
		const h = harness();
		const result = showSettingsPicker(h.ui, {
			title: "Notify",
			rows: () => [{ key: "x", section: "Only", label: "x", value: "1" }],
			sectionTabs: true,
			onAction: () => undefined,
		});
		expect(h.frame()).not.toContain("` sub-tab");
		h.press("`");
		expect(h.frame()).toContain("x");
		h.press("\x1b");
		expect(await result).toBeNull();
	});
});

describe("filterChoices", () => {
	test("matches the value or the hint, case-insensitive", () => {
		const choices = [
			{ value: "en", hint: "English" },
			{ value: "es", hint: "Spanish" },
		];
		expect(filterChoices(choices, "SPAN")).toEqual([{ value: "es", hint: "Spanish" }]);
		expect(filterChoices(choices, "e")).toHaveLength(2);
		expect(filterChoices(choices, "")).toBe(choices);
	});
});

describe("settings overview rows", () => {
	test("groups rows by section and colors each value by its tone", () => {
		const { lines, rowLines } = renderSettingsRows(
			[
				{ key: "a", section: "Web search", label: "provider", value: "exa · connected" },
				{ key: "b", section: "Web search", label: "9router model", value: "exa", tone: "muted" },
				{ key: "c", section: "Web fetch", label: "provider", value: "jina", tone: "warning" },
			],
			theme,
			0,
		);
		expect(lines).toEqual([
			"<dim>  Web search</dim>",
			"<accent>→</accent> <accent>provider     </accent>  <success>exa · connected</success>",
			"  <text>9router model</text>  <muted>exa</muted>",
			"",
			"<dim>  Web fetch</dim>",
			"  <text>provider     </text>  <warning>jina</warning>",
		]);
		expect(rowLines).toEqual([1, 2, 5]);
	});

	test("draws the text field inside the selected editable row", () => {
		const field = { render: () => ["> dg/nova-2█"] };
		const { lines } = renderSettingsRows(
			[{ key: "m", section: "STT", label: "model", value: "dg/nova-3", editable: true }],
			theme,
			0,
			field,
		);
		expect(lines[1]).toBe("<accent>→</accent> <accent>model</accent>  > dg/nova-2█");
	});

	test("dims the label of a turned-off row unless the cursor is on it", () => {
		const rows = [
			{
				key: "a",
				section: "",
				label: "welcome",
				value: "disabled",
				tone: "muted" as const,
				dim: true,
			},
			{ key: "b", section: "", label: "footer", value: "on" },
		];
		expect(renderSettingsRows(rows, theme, 1).lines[0]).toBe(
			"  <dim>welcome</dim>  <muted>disabled</muted>",
		);
		expect(renderSettingsRows(rows, theme, 0).lines[0]).toContain("<accent>welcome</accent>");
	});

	test("cuts a long dropdown choice to one line with an ellipsis", () => {
		const { lines } = renderSettingsRows(
			[{ key: "d", section: "STT", label: "mic", value: "a" }],
			theme,
			0,
			undefined,
			40,
			{ choices: [{ value: "x".repeat(100) }], cursor: 0, query: "" },
		);
		expect(lines.at(-1)).toMatch(
			/^ {7}<accent>▸<\/accent> <accent>x{20,35}(\x1b\[0m)?…(\x1b\[0m)?<\/accent>$/,
		);
	});

	test("cuts a long value to one line with an ellipsis", () => {
		const { lines } = renderSettingsRows(
			[{ key: "d", section: "STT", label: "mic", value: "x".repeat(100) }],
			theme,
			0,
			undefined,
			40,
		);
		expect(lines[1]).toMatch(
			/^<accent>→<\/accent> <accent>mic<\/accent> {2}<success>x{30,35}(\x1b\[0m)?…(\x1b\[0m)?<\/success>$/,
		);
	});
});

describe("provider picker rows", () => {
	test("colors each provider status by its state", () => {
		const { lines } = renderProviderRows(options(), theme, { cursor: 1, expanded: new Set() }, 80);
		expect(lines).toEqual([
			"    <muted>\u25CB</muted> <accent>auto</accent> <muted>choice</muted>",
			expect.stringMatching(
				/^<accent>▶<\/accent> <muted>▸<\/muted> <accent>●<\/accent> <accent>openai<\/accent> <success>connected<\/success><muted> · default<\/muted>$/,
			),
			expect.stringMatching(/<accent>deepgram<\/accent> <warning>1 variable not set<\/warning>$/),
			expect.stringMatching(/<accent>local<\/accent> <success>no API key needed<\/success>$/),
		]);
	});

	test("expanded rows show env state, an export example, and the model", () => {
		delete process.env.DEEPGRAM_API_KEY;
		process.env.OPENAI_API_KEY = "x";
		const { lines } = renderProviderRows(
			options(),
			theme,
			{ cursor: 0, expanded: new Set(["openai", "deepgram"]) },
			80,
		);
		expect(lines.slice(2, 4)).toEqual([
			"      <accent>OPENAI_API_KEY</accent> <success>\u25CF set</success>",
			"      <accent>model</accent>: <muted>whisper-1</muted>",
		]);
		expect(lines.slice(5, 7)).toEqual([
			"      <accent>DEEPGRAM_API_KEY</accent> <muted>\u25CB not set</muted>",
			'        <warning>export DEEPGRAM_API_KEY="your-api-key"</warning>',
		]);
	});

	test("a legacy alias counts as set", () => {
		delete process.env.NINEROUTER_KEY;
		process.env.ROUTER_API_KEY = "x";
		const opts = options();
		opts.rows = [{ id: "9router", configured: true, env: ["NINEROUTER_KEY"] }];
		const { lines } = renderProviderRows(
			opts,
			theme,
			{ cursor: 0, expanded: new Set(["9router"]) },
			80,
		);
		expect(lines[1]).toBe(
			"      <accent>NINEROUTER_KEY / ROUTER_API_KEY</accent> <success>\u25CF set</success>",
		);
	});
});
