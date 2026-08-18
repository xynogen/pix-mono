/**
 * pix-command-keys.test.ts — keyboard handling of the /pix settings overlay.
 *
 * Regression tests for the Kitty keyboard protocol: terminals like Ghostty
 * encode arrows, escape, and plain letters as CSI-u escape sequences, so raw
 * string compares silently no-op. Every action is asserted under BOTH the
 * legacy and Kitty encodings.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	KeybindingsManager,
	setKittyProtocolActive,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { registerPixCommand } from "./pix-command.ts";
import { compactionSection } from "./sections/compaction.ts";
import { ioSection } from "./sections/io.ts";
import { prettySection } from "./sections/pretty.ts";
import { createIsolatedRuntime, type IsolatedRuntime } from "./testing.ts";

// ── Key fixtures (legacy bytes vs Kitty protocol sequences) ───────────────────
const KEYS = {
	up: { legacy: "\u001b[A", kitty: "\u001b[1;1A" },
	down: { legacy: "\u001b[B", kitty: "\u001b[1;1B" },
	left: { legacy: "\u001b[D", kitty: "\u001b[1;1D" },
	right: { legacy: "\u001b[C", kitty: "\u001b[1;1C" },
	escape: { legacy: "\u001b", kitty: "\u001b[27u" },
	enter: { legacy: "\r", kitty: "\u001b[13u" },
	space: { legacy: " ", kitty: "\u001b[32u" },
	pageUp: { legacy: "\u001b[5~", kitty: "\u001b[57421u" },
	pageDown: { legacy: "\u001b[6~", kitty: "\u001b[57422u" },
	k: { legacy: "k", kitty: "\u001b[107u" },
	j: { legacy: "j", kitty: "\u001b[106u" },
	q: { legacy: "q", kitty: "\u001b[113u" },
} as const;

const ENCODINGS = ["legacy", "kitty"] as const;

// ── Harness ───────────────────────────────────────────────────────────────────

interface Overlay {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

interface Driver {
	feed(data: string): void;
	/** Wait for fire-and-forget runtime.update() calls to land. */
	settle(): Promise<void>;
	lines(): string[];
	cursorLine(): string | undefined;
	closed(): boolean;
	iconsValue(): string;
	timeoutValue(): number;
	triggerPercentValue(): number;
	minimumTokensValue(): number;
	maxRenderWidthValue(): number | `${number}%`;
	maxRenderHeightValue(): number | `${number}%`;
	cleanup(): void;
}

let active: IsolatedRuntime | undefined;
afterEach(() => {
	active?.cleanup();
	active = undefined;
});

/** Register /pix against a mock host + isolated runtime and open its overlay. */
async function openOverlay(kb = getKeybindings()): Promise<Driver> {
	const iso = createIsolatedRuntime();
	active = iso;
	await iso.runtime.init();

	let overlay: Overlay | undefined;
	let closed = false;

	let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		registerCommand: (_name: string, spec: { handler: typeof commandHandler }) => {
			commandHandler = spec.handler;
		},
	} as unknown as ExtensionAPI;

	registerPixCommand(pi, iso.runtime);
	if (!commandHandler) throw new Error("/pix did not register");

	const theme = {
		fg: (_c: string, t: string) => t,
		bg: (_c: string, t: string) => t,
		bold: (t: string) => t,
	};
	const ctx = {
		ui: {
			theme,
			notify: () => {},
			custom: async <T>(
				cb: (
					tui: { requestRender(): void; terminal?: { rows?: number } },
					th: typeof theme,
					kb: unknown,
					done: (v: T) => void,
				) => Overlay,
			): Promise<T | undefined> => {
				overlay = cb({ requestRender: () => {}, terminal: { rows: 12 } }, theme, kb, () => {
					closed = true;
				});
				return undefined;
			},
		},
	};

	await commandHandler("", ctx);
	if (!overlay) throw new Error("overlay was not constructed");
	const comp = overlay;

	return {
		feed: (data) => comp.handleInput(data),
		// The overlay's cycle() fires `void runtime.update(...)` without awaiting;
		// yield to the event loop so the write lands before the test reads back.
		settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
		lines: () => comp.render(52),
		cursorLine: () => comp.render(52).find((l) => l.includes("→")),
		closed: () => closed,
		// First row is Pretty/icons; read the live value through the runtime.
		iconsValue: () => iso.runtime.get(prettySection).icons,
		timeoutValue: () => iso.runtime.get(ioSection).timeoutSec,
		triggerPercentValue: () => iso.runtime.get(compactionSection).triggerPercent,
		minimumTokensValue: () => iso.runtime.get(compactionSection).minimumTokens,
		maxRenderWidthValue: () => iso.runtime.get(prettySection).maxRenderWidth,
		maxRenderHeightValue: () => iso.runtime.get(prettySection).maxRenderHeight,
		cleanup: () => iso.cleanup(),
	};
}

// ── Tests ─────────────────────────────────────────────────────────────────────

for (const enc of ENCODINGS) {
	describe(`/pix overlay keys (${enc} encoding)`, () => {
		it("down arrow moves without changing the selected value", async () => {
			const d = await openOverlay();
			const first = d.cursorLine();
			const icons = d.iconsValue();
			expect(first).toBeDefined();
			d.feed(KEYS.down[enc]);
			await d.settle();
			expect(d.cursorLine()).not.toBe(first);
			expect(d.iconsValue()).toBe(icons);
		});

		it("configured select actions move and return to the same row", async () => {
			const kb = new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.down": "j",
				"tui.select.up": "k",
			});
			const d = await openOverlay(kb);
			const first = d.cursorLine();
			d.feed(KEYS.j[enc]);
			expect(d.cursorLine()).not.toBe(first);
			d.feed(KEYS.k[enc]);
			expect(d.cursorLine()).toBe(first);
		});

		it("right arrow cycles the first setting's value", async () => {
			const d = await openOverlay();
			const before = d.iconsValue();
			d.feed(KEYS.right[enc]);
			await d.settle();
			expect(d.iconsValue()).not.toBe(before);
		});

		it("left arrow cycles backward, undoing a right cycle", async () => {
			const d = await openOverlay();
			const before = d.iconsValue();
			d.feed(KEYS.right[enc]);
			await d.settle();
			d.feed(KEYS.left[enc]);
			await d.settle();
			expect(d.iconsValue()).toBe(before);
		});

		it("space and enter do not change values", async () => {
			const d = await openOverlay();
			const before = d.iconsValue();
			d.feed(KEYS.space[enc]);
			d.feed(KEYS.enter[enc]);
			await d.settle();
			expect(d.iconsValue()).toBe(before);
		});

		it("escape closes the overlay", async () => {
			const d = await openOverlay();
			d.feed(KEYS.escape[enc]);
			expect(d.closed()).toBe(true);
		});

		it("PageDown/PageUp page through overflow without closing", async () => {
			if (enc === "kitty") setKittyProtocolActive(true);
			try {
				const d = await openOverlay();
				const first = d.lines().join("\n");
				d.feed(KEYS.pageDown[enc]);
				const paged = d.lines().join("\n");
				expect(paged).not.toBe(first);
				expect(paged).toContain("PgUp/PgDn inspect");
				d.feed(KEYS.pageUp[enc]);
				expect(d.lines().join("\n")).toBe(first);
				expect(d.closed()).toBe(false);
			} finally {
				if (enc === "kitty") setKittyProtocolActive(false);
			}
		});

		it("configured cancel action closes the overlay", async () => {
			const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "q" });
			const d = await openOverlay(kb);
			d.feed(KEYS.q[enc]);
			expect(d.closed()).toBe(true);
		});
	});
}

describe("/pix modal sizing", () => {
	it("exposes and updates width and height limits", async () => {
		const d = await openOverlay();
		d.feed(KEYS.down.legacy);
		d.feed(KEYS.down.legacy);
		expect(d.cursorLine()).toContain("max modal width");
		expect(d.maxRenderWidthValue()).toBe("65%");
		d.feed(KEYS.right.legacy);
		await d.settle();
		expect(d.maxRenderWidthValue()).toBe("70%");
		for (let i = 0; i < 5; i++) d.feed(KEYS.left.legacy);
		await d.settle();
		expect(d.maxRenderWidthValue()).toBe(120);
		expect(d.cursorLine()).toContain("120 cols");

		d.feed(KEYS.down.legacy);
		expect(d.cursorLine()).toContain("max modal height");
		expect(d.maxRenderHeightValue()).toBe("80%");
		d.feed(KEYS.left.legacy);
		await d.settle();
		expect(d.maxRenderHeightValue()).toBe("75%");
		for (let i = 0; i < 6; i++) d.feed(KEYS.right.legacy);
		await d.settle();
		expect(d.maxRenderHeightValue()).toBe(12);
		expect(d.cursorLine()).toContain("12 rows");
	});
});

describe("/pix network timeout", () => {
	it("exposes and updates the shared timeout row", async () => {
		const d = await openOverlay();
		for (let i = 0; i < 6; i++) d.feed(KEYS.down.legacy);
		expect(d.cursorLine()).toContain("timeout (sec)");
		expect(d.timeoutValue()).toBe(30);
		d.feed(KEYS.right.legacy);
		await d.settle();
		expect(d.timeoutValue()).toBe(10);
	});
});

describe("/pix compaction floor", () => {
	it("rapid right presses each advance one step (no stale-read collapse)", async () => {
		const d = await openOverlay();
		for (let i = 0; i < 7; i++) d.feed(KEYS.down.legacy);
		expect(d.cursorLine()).toContain("Trigger (% ctx)");
		expect(d.triggerPercentValue()).toBe(60);
		// Two presses before any settle — both must land: 60 → 65 → 70.
		d.feed(KEYS.right.legacy);
		d.feed(KEYS.right.legacy);
		await d.settle();
		expect(d.triggerPercentValue()).toBe(70);
	});

	it("down moves from trigger to minimum tokens without changing either number", async () => {
		const d = await openOverlay();
		for (let i = 0; i < 7; i++) d.feed(KEYS.down.legacy);
		expect(d.cursorLine()).toContain("Trigger (% ctx)");
		const triggerPercent = d.triggerPercentValue();
		const minimumTokens = d.minimumTokensValue();
		d.feed(KEYS.down.legacy);
		await d.settle();
		expect(d.cursorLine()).toContain("Minimum tokens");
		expect(d.triggerPercentValue()).toBe(triggerPercent);
		expect(d.minimumTokensValue()).toBe(minimumTokens);
	});

	it("offers 25k through 600k and defaults to 100k", async () => {
		const d = await openOverlay();
		for (let i = 0; i < 8; i++) d.feed(KEYS.down.legacy);
		expect(d.cursorLine()).toContain("Minimum tokens");
		expect(d.cursorLine()).toContain("100k");
		expect(d.minimumTokensValue()).toBe(100_000);
		// 100k → 150k (next option up).
		d.feed(KEYS.right.legacy);
		await d.settle();
		expect(d.minimumTokensValue()).toBe(150_000);
		// Left steps back to 100k.
		d.feed(KEYS.left.legacy);
		await d.settle();
		expect(d.minimumTokensValue()).toBe(100_000);
		// Left again to 50k (the new low options are reachable).
		d.feed(KEYS.left.legacy);
		await d.settle();
		expect(d.minimumTokensValue()).toBe(50_000);
	});
});

describe("/pix overlay frame", () => {
	it("renders a rounded border around every settings row", async () => {
		const d = await openOverlay();
		const lines = d.lines();

		expect(lines[0]).toMatch(/^╭─+╮$/);
		expect(lines.at(-1)).toMatch(/^╰─+╯$/);
		expect(lines.length).toBeGreaterThan(2);
		for (const line of lines.slice(1, -1)) expect(line).toMatch(/^│ .* │$/);
	});
});

describe("/pix overlay keys (guards)", () => {
	it("shift+k (Kitty) must not move the cursor", async () => {
		const d = await openOverlay();
		const first = d.cursorLine();
		d.feed("\u001b[107;2u"); // shift+k
		expect(d.cursorLine()).toBe(first);
	});

	it("unbound letters neither move, cycle, nor close", async () => {
		const d = await openOverlay();
		const first = d.cursorLine();
		const icons = d.iconsValue();
		for (const key of ["h", "l", "x", "\u001b[104u", "\u001b[108u", "\u001b[120u"]) d.feed(key);
		await d.settle();
		expect(d.cursorLine()).toBe(first);
		expect(d.iconsValue()).toBe(icons);
		expect(d.closed()).toBe(false);
	});
});
