import { expect, it } from "bun:test";
import * as shim from "./icon-catalog.ts";

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
