/**
 * opt-keys.test.ts — keyboard handling of the /optimizer overlay.
 *
 * Regression tests for the Kitty keyboard protocol: terminals like Ghostty
 * encode arrows, escape, and even plain letters as CSI-u escape sequences,
 * so raw string compares (`data === "k"`, `data === "\u001b[A"`) silently
 * no-op. Every action is asserted under BOTH encodings, with sequences fed
 * through the real pi-tui matcher.
 */

import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOptCommand } from "./opt.ts";
import type { OptimizerHandle, OptimizerStatus, OptimizerTool } from "./status.ts";

// ── Key fixtures ──────────────────────────────────────────────────────────────
// Legacy = classic terminal bytes. Kitty = CSI-u / modifier-form sequences as
// sent under the Kitty keyboard protocol (codepoint;modifiers u).
const KEYS = {
	up: { legacy: "\u001b[A", kitty: "\u001b[1;1A" },
	down: { legacy: "\u001b[B", kitty: "\u001b[1;1B" },
	left: { legacy: "\u001b[D", kitty: "\u001b[1;1D" },
	right: { legacy: "\u001b[C", kitty: "\u001b[1;1C" },
	escape: { legacy: "\u001b", kitty: "\u001b[27u" },
	enter: { legacy: "\r", kitty: "\u001b[13u" },
	space: { legacy: " ", kitty: "\u001b[32u" },
	k: { legacy: "k", kitty: "\u001b[107u" },
	j: { legacy: "j", kitty: "\u001b[106u" },
	h: { legacy: "h", kitty: "\u001b[104u" },
	l: { legacy: "l", kitty: "\u001b[108u" },
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
	selectedRow(): number;
	closed(): boolean;
	renders(): number;
	runs(): Array<{ tool: string; value: string }>;
}

/** Register /optimizer against a mock host and open its overlay. */
async function openOverlay(): Promise<Driver> {
	const runs: Array<{ tool: string; value: string }> = [];
	const mk = (name: OptimizerTool, current: string, values: string[]): OptimizerHandle => {
		let cur = current;
		return {
			name,
			help: `${name} — help`,
			values,
			current: () => cur,
			run: (value: string) => {
				cur = value;
				runs.push({ tool: name, value });
			},
		};
	};
	const handles: Record<OptimizerTool, OptimizerHandle> = {
		caveman: mk("caveman", "off", ["off", "lite", "full", "ultra", "micro"]),
		rtk: mk("rtk", "off", ["off", "on"]),
		ponytail: mk("ponytail", "off", ["off", "lite", "full", "ultra"]),
	};

	let overlay: Overlay | undefined;
	let closed = false;
	let renders = 0;

	let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		registerCommand: (_name: string, spec: { handler: typeof commandHandler }) => {
			commandHandler = spec.handler;
		},
	} as unknown as ExtensionAPI;

	registerOptCommand(pi, handles, {} as OptimizerStatus);
	if (!commandHandler) throw new Error("/optimizer did not register");

	const ctx = {
		ui: {
			theme: {
				fg: (_c: string, t: string) => t,
				bg: (_c: string, t: string) => t,
				bold: (t: string) => t,
			},
			notify: () => {},
			custom: async <T>(
				cb: (
					tui: { requestRender(): void },
					theme: unknown,
					kb: unknown,
					done: (v: T) => void,
				) => Overlay,
			): Promise<T | undefined> => {
				overlay = cb(
					{
						requestRender: () => {
							renders++;
						},
					},
					{
						fg: (_c: string, t: string) => t,
						bg: (_c: string, t: string) => t,
						bold: (t: string) => t,
					},
					undefined,
					() => {
						closed = true;
					},
				);
				return undefined;
			},
		},
	};

	// Fire the command; the mock custom() resolves immediately so this settles.
	await commandHandler("", ctx);
	if (!overlay) throw new Error("overlay was not constructed");
	const comp = overlay;

	return {
		feed: (data) => comp.handleInput(data),
		selectedRow: () => {
			// The selected row is the one rendered with the "→" cursor.
			const rows = comp
				.render(96)
				.filter((l) => l.includes("caveman") || l.includes("rtk") || l.includes("ponytail"));
			return rows.findIndex((l) => l.includes("→"));
		},
		closed: () => closed,
		renders: () => renders,
		runs: () => runs,
	};
}

// ── Tests ─────────────────────────────────────────────────────────────────────

for (const enc of ENCODINGS) {
	describe(`/optimizer overlay keys (${enc} encoding)`, () => {
		it("down arrow moves selection down", async () => {
			const d = await openOverlay();
			expect(d.selectedRow()).toBe(0);
			d.feed(KEYS.down[enc]);
			expect(d.selectedRow()).toBe(1);
		});

		it("up arrow wraps from first row to last", async () => {
			const d = await openOverlay();
			d.feed(KEYS.up[enc]);
			expect(d.selectedRow()).toBe(2);
		});

		it("vim j/k move selection", async () => {
			const d = await openOverlay();
			d.feed(KEYS.j[enc]);
			expect(d.selectedRow()).toBe(1);
			d.feed(KEYS.k[enc]);
			expect(d.selectedRow()).toBe(0);
		});

		it("right arrow cycles the selected tool's value forward", async () => {
			const d = await openOverlay();
			d.feed(KEYS.right[enc]);
			expect(d.runs()).toEqual([{ tool: "caveman", value: "lite" }]);
		});

		it("left arrow cycles backward (wraps to last value)", async () => {
			const d = await openOverlay();
			d.feed(KEYS.left[enc]);
			expect(d.runs()).toEqual([{ tool: "caveman", value: "micro" }]);
		});

		it("vim h/l cycle values", async () => {
			const d = await openOverlay();
			d.feed(KEYS.l[enc]);
			d.feed(KEYS.h[enc]);
			expect(d.runs()).toEqual([
				{ tool: "caveman", value: "lite" },
				{ tool: "caveman", value: "off" },
			]);
		});

		it("space and enter cycle forward", async () => {
			const d = await openOverlay();
			d.feed(KEYS.space[enc]);
			d.feed(KEYS.enter[enc]);
			expect(d.runs()).toEqual([
				{ tool: "caveman", value: "lite" },
				{ tool: "caveman", value: "full" },
			]);
		});

		it("escape closes the overlay", async () => {
			const d = await openOverlay();
			d.feed(KEYS.escape[enc]);
			expect(d.closed()).toBe(true);
		});

		it("q closes the overlay", async () => {
			const d = await openOverlay();
			d.feed(KEYS.q[enc]);
			expect(d.closed()).toBe(true);
		});

		it("handled keys trigger a re-render; unknown keys do not", async () => {
			const d = await openOverlay();
			d.feed(KEYS.down[enc]);
			const after = d.renders();
			expect(after).toBeGreaterThan(0);
			d.feed("x"); // unbound key
			expect(d.renders()).toBe(after);
		});
	});
}

describe("/optimizer overlay keys (guards)", () => {
	it("shift+k (Kitty) does not move selection — modifier must not match plain k", async () => {
		const d = await openOverlay();
		d.feed("\u001b[107;2u"); // shift+k
		expect(d.selectedRow()).toBe(0);
	});
});
