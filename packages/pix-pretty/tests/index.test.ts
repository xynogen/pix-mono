/**
 * Smoke tests for pix-pretty (pure lib).
 * UI extension tests moved to pix-display.
 */

import { describe, expect, it } from "bun:test";

describe("pix-pretty", () => {
	it("main module exports a function", async () => {
		const mod = await import("../src/index");
		expect(mod.default).toBeFunction();
	});
});
