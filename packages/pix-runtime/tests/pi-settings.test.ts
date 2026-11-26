import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, tempDir } from "../src/paths.ts";
import {
	piSettingsPath,
	readPiSettings,
	setPiSettings,
	updatePiSettings,
} from "../src/pi-settings.ts";

const file = () => join(mkdtempSync(join(tempDir(), "pix-settings-")), "settings.json");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("readPiSettings", () => {
	it("returns {} for a missing or empty file and strips a BOM", () => {
		const path = file();
		expect(readPiSettings(path)).toEqual({});
		writeFileSync(path, "  \n");
		expect(readPiSettings(path)).toEqual({});
		writeFileSync(path, '\uFEFF{"a":1}');
		expect(readPiSettings(path)).toEqual({ a: 1 });
	});

	it("throws on invalid JSON or a non-object", () => {
		const path = file();
		writeFileSync(path, "{invalid");
		expect(() => readPiSettings(path)).toThrow();
		writeFileSync(path, "[1]");
		expect(() => readPiSettings(path)).toThrow("Invalid Pi settings");
	});

	it("defaults to <agentDir>/settings.json", () => {
		expect(piSettingsPath()).toBe(join(agentDir(), "settings.json"));
	});
});

describe("setPiSettings", () => {
	it("creates the file, keeps other keys, and writes nothing when unchanged", () => {
		const path = file();
		expect(setPiSettings({ a: 1 }, { path, mode: 0o644 })).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o644);
		writeFileSync(path, '{"theme":"x"}\n');
		expect(setPiSettings({ a: 1 }, { path })).toBe(true);
		expect(read(path)).toEqual({ theme: "x", a: 1 });
		const before = readFileSync(path, "utf8");
		expect(setPiSettings({ a: 1 }, { path })).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("merges object values key by key", () => {
		const path = file();
		writeFileSync(path, '{"markdown":{"mermaid":"on","tables":true}}');
		setPiSettings({ markdown: { mermaid: "off" } }, { path });
		expect(read(path)).toEqual({ markdown: { mermaid: "off", tables: true } });
	});

	it("onlyMissing keeps a value the user set, even false", () => {
		const path = file();
		writeFileSync(path, '{"quietStartup":false}\n');
		expect(setPiSettings({ quietStartup: true }, { path, onlyMissing: true })).toBe(false);
		expect(read(path)).toEqual({ quietStartup: false });
	});

	it("keeps the mode of an existing file", () => {
		const path = file();
		writeFileSync(path, "{}");
		chmodSync(path, 0o640);
		setPiSettings({ a: 1 }, { path, mode: 0o600 });
		expect(statSync(path).mode & 0o777).toBe(0o640);
	});

	it("never overwrites a file it could not read", () => {
		const path = file();
		writeFileSync(path, "{invalid");
		expect(() => setPiSettings({ a: 1 }, { path })).toThrow();
		expect(readFileSync(path, "utf8")).toBe("{invalid");
	});
});

describe("updatePiSettings", () => {
	it("lets the caller edit arrays and reports whether it wrote", () => {
		const path = file();
		writeFileSync(path, '{"extensions":["a"]}');
		const add = (s: Record<string, unknown>) => {
			const list = s.extensions as string[];
			if (!list.includes("-b")) list.push("-b");
		};
		expect(updatePiSettings(add, { path })).toBe(true);
		expect(updatePiSettings(add, { path })).toBe(false);
		expect(read(path)).toEqual({ extensions: ["a", "-b"] });
	});
});
