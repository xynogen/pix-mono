import { describe, expect, it } from "bun:test";
import { OptimizerStatus, renderStatus, STATUS_KEY, toolIcon } from "./status.ts";

/** Tagging colorizer: <accent>X</accent> / <muted>X</muted> for assertions. */
const tag = (c: string, t: string) => `<${c}>${t}</${c}>`;

// Icons resolve against the global pix-pretty mode (default "nerd" in tests).
const CV = toolIcon("caveman");
const RK = toolIcon("rtk");
const PT = toolIcon("ponytail");

describe("renderStatus", () => {
	it("shows ALL icons in order, accent when enabled", () => {
		expect(renderStatus({ caveman: true, rtk: true, ponytail: true }, tag)).toBe(
			`<accent>${CV}</accent>  <accent>${RK}</accent>  <accent>${PT}</accent> `,
		);
	});

	it("mutes disabled tools but still shows them", () => {
		expect(renderStatus({ caveman: false, rtk: true, ponytail: true }, tag)).toBe(
			`<muted>${CV}</muted>  <accent>${RK}</accent>  <accent>${PT}</accent> `,
		);
	});

	it("all muted when nothing enabled (cell never empty)", () => {
		expect(renderStatus({}, tag)).toBe(
			`<muted>${CV}</muted>  <muted>${RK}</muted>  <muted>${PT}</muted> `,
		);
	});

	it("preserves fixed order regardless of insertion order", () => {
		expect(renderStatus({ ponytail: true, caveman: true }, tag)).toBe(
			`<accent>${CV}</accent>  <muted>${RK}</muted>  <accent>${PT}</accent> `,
		);
	});

	it("resolves icons via the shared catalog (non-empty glyphs)", () => {
		// toolIcon delegates to pix-pretty's icon(); every tool has a glyph.
		expect([CV, RK, PT].every((g) => g.length > 0)).toBe(true);
	});
});

describe("OptimizerStatus", () => {
	/** Minimal ui stub capturing setStatus calls. */
	function fakeCtx() {
		const calls: { key: string; text: string }[] = [];
		return {
			calls,
			ui: {
				setStatus: (key: string, text: string | undefined) => calls.push({ key, text: text ?? "" }),
				theme: { fg: (c: string, t: string) => `<${c}>${t}</${c}>` },
			},
		} as const;
	}

	it("paints the shared key with per-icon accent/muted", () => {
		const status = new OptimizerStatus();
		const ctx = fakeCtx();
		status.set("rtk", true, ctx as never);
		const last = ctx.calls.at(-1);
		if (!last) throw new Error("no calls");
		expect(last.key).toBe(STATUS_KEY);
		// caveman + ponytail still unset (muted), rtk accent.
		expect(last.text).toBe(`<muted>${CV}</muted>  <accent>${RK}</accent>  <muted>${PT}</muted> `);
	});

	it("accumulates state across tools", () => {
		const status = new OptimizerStatus();
		const ctx = fakeCtx();
		status.set("caveman", true, ctx as never);
		status.set("ponytail", true, ctx as never);
		const last = ctx.calls.at(-1);
		if (!last) throw new Error("no calls");
		expect(last.text).toBe(`<accent>${CV}</accent>  <muted>${RK}</muted>  <accent>${PT}</accent> `);
	});

	it("mutes an icon when its tool toggles off (cell stays populated)", () => {
		const status = new OptimizerStatus();
		const ctx = fakeCtx();
		status.set("rtk", true, ctx as never);
		status.set("rtk", false, ctx as never);
		const last = ctx.calls.at(-1);
		if (!last) throw new Error("no calls");
		expect(last.text).toBe(`<muted>${CV}</muted>  <muted>${RK}</muted>  <muted>${PT}</muted> `);
	});
});
