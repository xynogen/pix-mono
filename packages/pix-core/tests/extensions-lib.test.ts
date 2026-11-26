import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
	installedStandalone,
	isMemberDisabled,
	LOCKED_MEMBERS,
	memberPackage,
	packageCommand,
	STANDALONE_PACKAGES,
	shortName,
	toggleDisabled,
} from "../src/extensions-lib.ts";
import { extensionRows } from "../src/extensions-panel.ts";

const WELCOME = "@xynogen/pix-welcome";

describe("extensions-lib", () => {
	test("member specifiers map to packages and short names", () => {
		expect(memberPackage("@xynogen/pix-footer/extension")).toBe("@xynogen/pix-footer");
		expect(memberPackage("@xynogen/pix-display")).toBe("@xynogen/pix-display");
		expect(shortName("@xynogen/pix-footer")).toBe("footer");
	});

	test("a disabled member is skipped; a locked member never is", () => {
		expect(isMemberDisabled("@xynogen/pix-welcome/extension", [WELCOME])).toBe(true);
		expect(isMemberDisabled("@xynogen/pix-footer/extension", [WELCOME])).toBe(false);
		expect(isMemberDisabled("@xynogen/pix-gate", ["@xynogen/pix-gate"])).toBe(false);
	});

	test("toggle adds and removes sorted; locked members never enter the list", () => {
		expect(toggleDisabled(["@xynogen/pix-todo"], WELCOME)).toEqual(["@xynogen/pix-todo", WELCOME]);
		expect(toggleDisabled([WELCOME], WELCOME)).toEqual([]);
		for (const pkg of LOCKED_MEMBERS) expect(toggleDisabled([], pkg)).toEqual([]);
	});

	test("installed standalone packages keep the source Pi recorded", () => {
		const found = installedStandalone([
			"npm:@xynogen/pix-web",
			"npm:@xynogen/pix-voice@1.2.3",
			{ source: "/home/u/pix-mono/packages/pix-mcp/" },
			"npm:@xynogen/pix-core",
			42,
		]);
		expect([...found]).toEqual([
			["@xynogen/pix-web", "npm:@xynogen/pix-web"],
			["@xynogen/pix-voice", "npm:@xynogen/pix-voice@1.2.3"],
			["@xynogen/pix-mcp", "/home/u/pix-mono/packages/pix-mcp/"],
		]);
		expect(installedStandalone(undefined).size).toBe(0);
	});

	test("install uses npm; remove uses the recorded source; others are refused", () => {
		expect(packageCommand("install", "@xynogen/pix-web")).toEqual([
			"install",
			"npm:@xynogen/pix-web",
		]);
		expect(packageCommand("remove", "@xynogen/pix-web", "/p/pix-web")).toEqual([
			"remove",
			"/p/pix-web",
		]);
		expect(() => packageCommand("install", "@xynogen/pix-core")).toThrow("Not a standalone");
	});

	test("every standalone package exists in this repo", () => {
		const dirs = new Set(readdirSync(new URL("../../", import.meta.url)));
		for (const pkg of STANDALONE_PACKAGES) expect(dirs.has(`pix-${shortName(pkg)}`)).toBe(true);
	});
});

describe("extensionRows", () => {
	const members = [
		"@xynogen/pix-runtime",
		"@xynogen/pix-welcome/extension",
		"@xynogen/pix-footer/extension",
	];

	test("a disabled member reads `disabled` and is dimmed; locked members read `always on`", () => {
		const rows = extensionRows(members, [WELCOME], new Map());
		const row = (label: string) => rows.find((r) => r.label === label);
		expect(row("runtime")).toMatchObject({ value: "always on", tone: "muted" });
		expect(row("welcome")).toMatchObject({ value: "disabled", tone: "muted", dim: true });
		expect(row("footer")).toMatchObject({ value: "on", tone: "success", dim: false });
	});

	test("standalone rows offer install or remove", () => {
		const rows = extensionRows([], [], new Map([["@xynogen/pix-web", "npm:@xynogen/pix-web"]]));
		expect(rows.find((r) => r.label === "web")).toMatchObject({ key: "remove:@xynogen/pix-web" });
		expect(rows.find((r) => r.label === "voice")).toMatchObject({
			key: "install:@xynogen/pix-voice",
		});
	});
});
