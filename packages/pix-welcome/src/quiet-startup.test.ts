import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { patchQuietStartup } from "./quiet-startup.ts";

const settingsPath = () =>
	join(mkdtempSync(join(tempDir(), "pix-welcome-settings-")), "settings.json");

describe("quiet startup patch", () => {
	it("adds quietStartup once and keeps other settings", () => {
		const path = settingsPath();
		writeFileSync(path, '{"theme":"system"}\n');
		expect(patchQuietStartup(path)).toBe(true);
		const first = readFileSync(path, "utf8");
		expect(JSON.parse(first)).toEqual({ theme: "system", quietStartup: true });
		expect(patchQuietStartup(path)).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(first);
	});

	it("keeps an explicit user value and does not overwrite invalid settings", () => {
		const path = settingsPath();
		const explicit = '{"quietStartup":false}\n';
		writeFileSync(path, explicit);
		expect(patchQuietStartup(path)).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(explicit);
		writeFileSync(path, "{invalid");
		expect(() => patchQuietStartup(path)).toThrow();
		expect(readFileSync(path, "utf8")).toBe("{invalid");
	});
});
