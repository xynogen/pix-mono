import { afterEach, describe, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import { cacheDir } from "@xynogen/pix-runtime/paths";
import { getPiPrettyFffDir } from "../src/fff.ts";

const saved = process.env.PRETTY_FFF_DIR;
afterEach(() => {
	if (saved === undefined) delete process.env.PRETTY_FFF_DIR;
	else process.env.PRETTY_FFF_DIR = saved;
});

describe("getPiPrettyFffDir", () => {
	test("defaults to an absolute <cacheDir>/fff even without HOME", () => {
		delete process.env.PRETTY_FFF_DIR;
		const dir = getPiPrettyFffDir();
		expect(isAbsolute(dir)).toBe(true);
		expect(dir).toBe(join(cacheDir(), "fff"));
	});

	test("PRETTY_FFF_DIR overrides", () => {
		process.env.PRETTY_FFF_DIR = "/tmp/fff-x";
		expect(getPiPrettyFffDir()).toBe("/tmp/fff-x");
	});
});
