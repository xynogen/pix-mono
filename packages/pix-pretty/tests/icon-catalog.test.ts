import { expect, it } from "bun:test";
import * as shim from "../src/icon-catalog.ts";

// The catalog itself lives in @xynogen/pix-runtime and is tested there. This
// file only guards the re-export shim: every public name must stay reachable
// through @xynogen/pix-pretty/icon-catalog so existing import sites don't break.
it("re-exports the full icon-catalog surface", () => {
	expect(typeof shim.icon).toBe("function");
	expect(typeof shim.iconFor).toBe("function");
	expect(typeof shim.getIconMode).toBe("function");
	expect(typeof shim.setIconMode).toBe("function");
	expect(typeof shim.onIconModeChange).toBe("function");
	expect(Array.isArray(shim.ICON_MODES)).toBe(true);
	expect(Array.isArray(shim.ICON_KEYS)).toBe(true);
	// Resolves through the shim (default nerd mode).
	expect(shim.icon("cwd")).toBe("\u{F024B}");
});

it("resolves pix-pretty's own icons in every mode", () => {
	for (const key of shim.PRETTY_ICON_KEYS) {
		for (const mode of shim.ICON_MODES) expect(shim.iconFor(key, mode).length).toBeGreaterThan(0);
	}
	expect(shim.iconFor("mode.plan", "ascii")).toBe("P");
	expect(shim.iconFor("mode.normal", "ascii")).toBe(">");
	expect(shim.iconFor("mode.nuclear", "unicode")).toBe("\u{1F680}");
	expect(shim.iconFor("mode.nuclear", "nerd")).toBe("\u{F135}");
	expect(shim.iconFor("mode.nuclear", "ascii")).toBe("^");
	expect(shim.iconFor("mode.plan", "nerd")).not.toBe(shim.iconFor("mode.normal", "nerd"));
});
