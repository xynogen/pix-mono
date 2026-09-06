/**
 * Smoke tests for pix-display extensions.
 */

import { describe, expect, it } from "bun:test";

describe("pix-display", () => {
	describe("inline-chips extension", () => {
		it("exports a function", async () => {
			const mod = await import("../src/inline-chips.js");
			expect(mod.default).toBeFunction();
		});
	});

	describe("thinking extension", () => {
		it("exports a function", async () => {
			const mod = await import("../src/thinking.js");
			expect(mod.default).toBeFunction();
		});
	});

	describe("index", () => {
		it("exports a function", async () => {
			const mod = await import("../src/index.js");
			expect(mod.default).toBeFunction();
		});
	});
});
