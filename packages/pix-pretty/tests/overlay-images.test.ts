import { expect, test } from "bun:test";
import {
	type Component,
	getCapabilities,
	setCapabilities,
	type Terminal,
	TuiAltScreen,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { installOverlayImages } from "../src/overlay-images.ts";

class MainProbe extends TuiMainScreen {
	override requestRender() {}
	compose(lines: string[]) {
		return this.compositeOverlays(lines, 40, 10);
	}
	paint() {
		this.renderNow();
	}
}
class FullscreenProbe extends TuiAltScreen {
	override requestRender() {}
	compose(lines: string[]) {
		return this.compositeOverlays(lines, 40, 10);
	}
	private active = false;
	paint() {
		if (!this.active) {
			const capabilities = getCapabilities();
			setCapabilities({ ...capabilities, images: "kitty" });
			try {
				this.beforeTerminalStart();
			} finally {
				setCapabilities(capabilities);
			}
			this.active = true;
		}
		this.renderNow();
	}
}

const kitty = "\x1b_Ga=T,f=100,i=42,c=10,r=3;AAAA\x1b\\";
const iterm = "\x1b]1337;File=inline=1:AAAA\x07";
const component: Component = { render: () => ["OVERLAY"], invalidate() {} };

for (const Probe of [MainProbe, FullscreenProbe]) {
	test(`${Probe.name}: visible and nested overlays suppress images without changing transcript rows`, () => {
		installOverlayImages();
		const writes: string[] = [];
		const terminal = {
			columns: 40,
			rows: 10,
			write: (s: string) => writes.push(s),
			hideCursor() {},
			showCursor() {},
		} as unknown as Terminal;
		const tui = new Probe(terminal);
		const lines = ["header", kitty, "", "", iterm, "", "", "", "", "footer"];
		expect(tui.compose(lines)).toBe(lines);
		const first = tui.showOverlay(component, { row: 1, col: 0, width: 20 });
		const screen = tui.compose(lines);
		expect(screen[1]).toContain("OVERLAY");
		expect(screen.join("\n")).not.toContain("\x1b_G");
		expect(screen.join("\n")).not.toContain("1337;File=");
		expect(screen).toHaveLength(lines.length);
		expect(lines[1]).toBe(kitty);
		const second = tui.showOverlay(component, { row: 4, col: 0, width: 20 });
		second.hide();
		expect(tui.compose(lines).join("\n")).not.toContain(kitty);
		first.setHidden(true);
		expect(tui.compose(lines)).toEqual(lines);
		first.setHidden(false);
		expect(tui.compose(lines)[1]).toContain("OVERLAY");
		first.hide();
		expect(tui.compose(lines)).toBe(lines);
		const hidden = tui.showOverlay(component, { visible: () => false });
		expect(tui.compose(lines)).toEqual(lines);
		hidden.hide();
		const compose = Object.getPrototypeOf(TuiMainScreen.prototype).compositeOverlays;
		installOverlayImages();
		expect(Object.getPrototypeOf(TuiMainScreen.prototype).compositeOverlays).toBe(compose);
	});

	test(`${Probe.name}: native renderer deletes a previous Kitty placement and restores it on close`, () => {
		installOverlayImages();
		const writes: string[] = [];
		const terminal = {
			columns: 40,
			rows: 10,
			write: (s: string) => writes.push(s),
			hideCursor() {},
			showCursor() {},
		} as unknown as Terminal;
		const tui = new Probe(terminal);
		const lines = ["header", kitty, "", "", "", "", "", "", "", "footer"];
		tui.addChild({ render: () => lines, invalidate() {} });
		tui.paint();
		writes.length = 0;
		const overlay = tui.showOverlay(component, { row: 2, col: 0, width: 20 });
		tui.paint();
		const output = writes.join("");
		expect(output).toContain("OVERLAY");
		expect(output).toMatch(/\x1b_Ga=d,/);
		expect(output).not.toContain("a=T");
		writes.length = 0;
		overlay.hide();
		tui.paint();
		expect(writes.join("")).toContain("a=T");
	});
}
