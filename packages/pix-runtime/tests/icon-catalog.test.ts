import { afterEach, describe, expect, it } from "bun:test";
import {
	getIconMode,
	ICON_KEYS,
	ICON_MODES,
	icon,
	iconFor,
	onIconModeChange,
	setIconMode,
} from "../src/icon-catalog.ts";

describe("icon-catalog", () => {
	afterEach(() => setIconMode("nerd")); // restore default for other suites

	it("shares mode and notifications across separately evaluated modules", async () => {
		const modulePath = "../src/icon-catalog.ts?separate-instance";
		const other: typeof import("../src/icon-catalog.ts") = await import(modulePath);
		const seen: string[] = [];
		const unsubscribe = other.onIconModeChange((mode: string) => seen.push(mode));
		try {
			setIconMode("ascii");
			expect(other.icon("status.ok")).toBe("ok");
			other.setIconMode("nerd");
			expect(getIconMode()).toBe("nerd");
			expect(seen).toEqual(["ascii", "nerd"]);
		} finally {
			unsubscribe();
		}
	});

	it("exposes nerd/unicode/ascii in cycle order", () => {
		expect([...ICON_MODES]).toEqual(["nerd", "unicode", "ascii"]);
	});

	it("resolves a key against the active mode", () => {
		setIconMode("ascii");
		expect(icon("cwd")).toBe("~");
		setIconMode("unicode");
		expect(icon("cwd")).toBe("\u2302\uFE0E");
		setIconMode("nerd");
		expect(icon("cwd")).toBe("\u{F024B}");
	});

	it("iconFor resolves without touching the active mode", () => {
		setIconMode("nerd");
		expect(iconFor("opt.caveman", "ascii")).toBe("Cv");
		expect(getIconMode()).toBe("nerd"); // unchanged
	});

	it("provides AFK keyboard fallbacks for every icon mode", () => {
		expect(iconFor("afk", "nerd")).toBe("\u{F0310}");
		expect(iconFor("afk", "unicode")).toBe("\u2328\uFE0E");
		expect(iconFor("afk", "ascii")).toBe("kbd");
	});

	it("provides player icons for audio output", () => {
		expect(iconFor("audio.play", "nerd")).toBe("\u{F04B}");
		expect(iconFor("audio.play", "unicode")).toBe("\u25B6\uFE0E");
		expect(iconFor("audio.play", "ascii")).toBe(">");
		expect(iconFor("audio.pause", "nerd")).toBe("\u{F04C}");
		expect(iconFor("audio.pause", "unicode")).toBe("\u23F8\uFE0E");
		expect(iconFor("audio.pause", "ascii")).toBe("||");
		expect(iconFor("audio.stop", "nerd")).toBe("\u{F04D}");
		expect(iconFor("audio.stop", "unicode")).toBe("\u25A0\uFE0E");
		expect(iconFor("audio.stop", "ascii")).toBe("[]");
		expect(iconFor("audio.file", "nerd")).toBe("\u{F1C7}");
		expect(iconFor("audio.file", "unicode")).toBe("\u266B\uFE0E");
		expect(iconFor("audio.file", "ascii")).toBe("audio");
	});

	it("every catalog key has a non-empty glyph in every mode", () => {
		for (const mode of ICON_MODES) {
			for (const key of ICON_KEYS) {
				expect(iconFor(key, mode).length).toBeGreaterThan(0);
			}
		}
	});

	it("status family keeps historical nerd glyphs and gains ascii tokens", () => {
		// nerd mode must equal the pre-catalog literals so mixed-glyph rows and
		// existing snapshot assertions stay aligned.
		expect(iconFor("status.ok", "nerd")).toBe("\u2713");
		expect(iconFor("status.error", "nerd")).toBe("\u2717");
		expect(iconFor("status.warn", "nerd")).toBe("\u26A0");
		expect(iconFor("status.pending", "nerd")).toBe("\u25CB");
		expect(iconFor("status.running", "nerd")).toBe("\u25D0");
		expect(iconFor("status.active", "nerd")).toBe("\u25CF");
		expect(iconFor("status.done", "nerd")).toBe("\u25CF");
		expect(iconFor("status.blocked", "nerd")).toBe("\u2298");
		// ascii mode must be tofu-free (letters/punctuation only).
		for (const key of [
			"status.ok",
			"status.error",
			"status.warn",
			"status.pending",
			"status.running",
			"status.active",
			"status.done",
			"status.blocked",
		] as const) {
			expect(iconFor(key, "ascii")).toMatch(/^[\x20-\x7e]+$/);
		}
	});

	it("unknown key fails soft to empty string", () => {
		// @ts-expect-error exercising the runtime guard
		expect(icon("does.not.exist")).toBe("");
	});

	it("setIconMode ignores an invalid mode", () => {
		setIconMode("unicode");
		// @ts-expect-error invalid mode must be rejected, leaving prior value
		setIconMode("bogus");
		expect(getIconMode()).toBe("unicode");
	});

	it("notifies subscribers on an actual change, not on no-ops", () => {
		setIconMode("nerd");
		const seen: string[] = [];
		const off = onIconModeChange((m) => seen.push(m));
		setIconMode("nerd"); // no-op — must NOT fire
		setIconMode("ascii"); // change — fires
		setIconMode("ascii"); // no-op — must NOT fire
		off();
		setIconMode("unicode"); // after unsubscribe — must NOT fire
		expect(seen).toEqual(["ascii"]);
	});
});
