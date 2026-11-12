import { expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Text, visibleWidth } from "@earendil-works/pi-tui";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import * as resolve from "../src/binaries/resolve.ts";
import * as store from "../src/binaries/store.ts";
import { createBinariesTab } from "../src/binaries-tab.ts";
import { getIconMode, ICON_MODES, icon, setIconMode } from "../src/icon-catalog.ts";
import { once } from "../src/once.ts";
import { registerPixCommand } from "../src/pix-command.ts";
import { prettySection } from "../src/sections/pretty.ts";

const theme = roleTheme();
test("Settings and Footer actual overlay captures", async () => {
	const fixture = await withUiFixture();
	try {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (_name: string, spec: { handler: typeof handler }) => {
				handler = spec.handler;
			},
		} as unknown as ExtensionAPI;
		for (const key of ["pix-core", "pix-diagnostics", "pix-gate", "pix-footer"])
			once(pi, key, () => {});
		registerPixCommand(pi, fixture.runtime);
		if (!handler) throw new Error("Missing pix command");
		let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
		let rows = 24;
		await handler("", {
			ui: {
				notify() {},
				custom: async (
					factory: (
						tui: unknown,
						theme: unknown,
						kb: unknown,
						done: () => void,
					) => typeof component,
				) => {
					component = factory(
						{
							requestRender() {},
							terminal: {
								get rows() {
									return rows;
								},
							},
						},
						theme,
						getKeybindings(),
						() => {},
					);
				},
			},
		});
		if (!component) throw new Error("Missing settings overlay");
		expect(captureRows(component, { width: 80, surface: "component" })).toMatchSnapshot("settings");
		component.handleInput("\x1b[6~");
		expect(captureRows(component, { width: 80, surface: "component" })).toMatchSnapshot("page");
		// Tab reaches Footer (second by usage order) without constructing the binary tab.
		component.handleInput("\t");
		await fixture.runtime.update(prettySection, { footer: { model: false } });
		expect(captureRows(component, { width: 80, surface: "component" })).toMatchSnapshot(
			"footer changed",
		);
		const originalMode = getIconMode();
		try {
			rows = 80;
			for (const mode of ICON_MODES) {
				setIconMode(mode);
				const footer = captureRows(component, { width: 100, surface: "component" }).join("\n");
				for (const [key, label] of [
					["model", "model"],
					["tokens", "tokens"],
					["sys.cpu", "system"],
					["turns", "wrap line"],
				] as const) {
					const iconW = mode === "ascii" ? 5 : 2;
					expect(footer).toContain(
						`${icon(key)}${" ".repeat(iconW - visibleWidth(icon(key)))} ${label}`,
					);
				}
				const columns = Object.keys(prettySection.defaults.footer).map((key) => {
					const label = key === "wrap" ? "wrap line" : key;
					const line = footer.split("\n").find((line) => line.includes(` ${label}`));
					if (!line) throw new Error(`Missing footer setting: ${key}`);
					const plain = line.replace(/<[^>]+>/g, "");
					return [
						visibleWidth(plain.slice(0, plain.indexOf(label))),
						visibleWidth(plain.slice(0, plain.search(/\b(show|hide|on|off)\b/))),
					];
				});
				expect(new Set(columns.map(([label]) => label)).size).toBe(1);
				expect(new Set(columns.map(([, value]) => value)).size).toBe(1);
			}
		} finally {
			setIconMode(originalMode);
			rows = 24;
		}
		rows = 40;
		for (let i = 0; i < Object.keys(prettySection.defaults.footer).length - 1; i++) {
			component.handleInput("\x1b[B");
			const narrow = component.render(23);
			expect(narrow.some((line) => line.includes("→"))).toBe(true);
			expect(narrow.every((line) => visibleWidth(line) <= 23)).toBe(true);
		}
		for (let i = 0; i < Object.keys(prettySection.defaults.footer).length - 1; i++) {
			component.handleInput("\x1b[A");
		}
		rows = 24;
		// `wrap` is the last footer flag: move past every other one.
		const footerFlags = Object.keys(prettySection.defaults.footer).length;
		for (let i = 0; i < footerFlags - 1; i++) component.handleInput("\x1b[B");
		expect(captureRows(component, { width: 80, surface: "component" }).join("\n")).toMatch(
			/wrap line.*off/,
		);
		component.handleInput("\x1b[C");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fixture.runtime.get(prettySection).footer.wrap).toBe(true);
		rows = 4;
		expect(captureRows(component, { width: 80, surface: "component" })).toMatchSnapshot(
			"short terminal",
		);
	} finally {
		await fixture.restore();
	}
});

test("binary tab captures isolate lookup and version probes", async () => {
	const fixture = await withUiFixture();
	const base = {
		hint: "install fixture",
		usedBy: ["pix-test"],
		downloadable: false,
		optional: false,
	};
	const lookups: resolve.ToolLookup[] = [
		{ ...base, name: "good", state: "ok", path: "/fixture/bin/good", source: "path" },
		{ ...base, name: "required", state: "missing" },
		{ ...base, name: "optional", state: "missing", optional: true },
		{ ...base, name: "broken", state: "broken", choice: "/fixture/gone" },
		{ ...base, name: "other", state: "unsupported" },
	];
	const lookup = spyOn(resolve, "listTools").mockReturnValue(lookups);
	const version = spyOn(resolve, "toolVersion").mockResolvedValue("1.2.3");
	const state = { path: "/fixture/agent/binary.json", choices: {}, exists: false };
	const sync = spyOn(store, "syncBinaryStore").mockReturnValue(state);
	const read = spyOn(store, "readBinaryStore").mockReturnValue(state);
	try {
		const ready = Promise.withResolvers<void>();
		const tab = createBinariesTab({ env: {}, theme, requestRender: () => ready.resolve() });
		await ready.promise;
		const capture = () => {
			const view = tab.view(80);
			return captureRows(new Text([...view.header, "", ...view.body].join("\n"), 0, 0), {
				width: 80,
				surface: "component",
			});
		};
		expect(capture()).toMatchSnapshot("states");
		const originalMode = getIconMode();
		try {
			for (const mode of ICON_MODES) {
				setIconMode(mode);
				const body = tab.view(80).body.map((line) => line.replace(/<[^>]+>/g, ""));
				const columns = lookups.map((row) => {
					const line = body.find((line) => line.includes(row.name));
					if (!line) throw new Error(`Missing binary: ${row.name}`);
					return visibleWidth(line.slice(0, line.indexOf(row.name)));
				});
				expect(new Set(columns).size).toBe(1);
			}
		} finally {
			setIconMode(originalMode);
		}
		expect(version).toHaveBeenCalledWith("good", "/fixture/bin/good");
		const keys = { up: false, down: false, enter: false };
		tab.handleInput("e", keys);
		expect(capture()).toMatchSnapshot("path editor");
		tab.handleInput("\x1b", keys);
		tab.handleInput("/", keys);
		tab.handleInput("nomatch", keys);
		expect(capture()).toMatchSnapshot("empty filter");
		sync.mockReturnValue({ ...state, error: "fixture invalid JSON" });
		lookup.mockReturnValue([
			{ ...base, name: "blocked", state: "broken", error: "fixture invalid JSON" },
		]);
		tab.clearFilter();
		tab.handleInput("\x1b", keys);
		tab.refresh();
		expect(capture()).toMatchSnapshot("invalid store");
	} finally {
		lookup.mockRestore();
		version.mockRestore();
		sync.mockRestore();
		read.mockRestore();
		await fixture.restore();
	}
});
