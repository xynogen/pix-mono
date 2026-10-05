import { expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Text } from "@earendil-works/pi-tui";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import * as resolve from "./binaries/resolve.ts";
import * as store from "./binaries/store.ts";
import { createBinariesTab } from "./binaries-tab.ts";
import { registerPixCommand } from "./pix-command.ts";
import { prettySection } from "./sections/pretty.ts";

const theme = roleTheme();
test("Settings and Footer actual overlay captures", async () => {
	const fixture = await withUiFixture();
	try {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		registerPixCommand(
			{
				registerCommand: (_name: string, spec: { handler: typeof handler }) => {
					handler = spec.handler;
				},
			} as unknown as ExtensionAPI,
			fixture.runtime,
		);
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
		// Reverse tab reaches Footer without constructing the binary tab.
		component.handleInput("\x1b[Z");
		await fixture.runtime.update(prettySection, { footer: { model: false } });
		expect(captureRows(component, { width: 80, surface: "component" })).toMatchSnapshot(
			"footer changed",
		);
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
