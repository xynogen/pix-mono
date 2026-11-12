import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectDir, tempDir } from "@xynogen/pix-runtime/paths";
import { prefsTarget, writePrefs } from "../src/project-prefs.ts";

const tmp = () => mkdtempSync(join(tempDir(), "pix-prefs-"));

describe("prefsTarget", () => {
	it("routes a trusted project to <cwd>/.pi/settings.json", () => {
		const home = tmp();
		const agent = join(projectDir(home), "agent");
		const cwd = join(home, "proj");
		expect(prefsTarget(cwd, true, agent)).toEqual({
			path: join(projectDir(cwd), "settings.json"),
			scope: "project",
		});
	});

	it("routes an untrusted project to the user settings file", () => {
		const agent = join(projectDir(tmp()), "agent");
		expect(prefsTarget(tmp(), false, agent)).toEqual({
			path: join(agent, "settings.json"),
			scope: "user",
		});
	});

	it("routes cwd === home (its .pi holds the agent dir) to the user file", () => {
		const home = tmp();
		const agent = join(projectDir(home), "agent");
		expect(prefsTarget(home, true, agent).scope).toBe("user");
	});
});

describe("writePrefs", () => {
	it("creates .pi/settings.json with model, provider and thinking together", () => {
		const path = join(projectDir(tmp()), "settings.json");
		expect(
			writePrefs(path, {
				defaultProvider: "p",
				defaultModel: "m",
				defaultThinkingLevel: "high",
			}),
		).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			defaultProvider: "p",
			defaultModel: "m",
			defaultThinkingLevel: "high",
		});
	});

	it("merges into existing settings and keeps unrelated keys", () => {
		const path = join(tmp(), "settings.json");
		writeFileSync(path, JSON.stringify({ theme: "x", defaultModel: "old" }));
		writePrefs(path, { defaultModel: "new" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "x", defaultModel: "new" });
	});

	it("reports no change when values already match", () => {
		const path = join(tmp(), "settings.json");
		writePrefs(path, { defaultModel: "m" });
		expect(writePrefs(path, { defaultModel: "m" })).toBe(false);
	});
});
