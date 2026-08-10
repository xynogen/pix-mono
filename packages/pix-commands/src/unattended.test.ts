import { afterEach, describe, expect, test } from "bun:test";
import {
	confirmYoloConsent,
	getMode,
	modelScore,
	setMode,
	unattendedBanner,
	YOLO_MIN_SCORE,
} from "./unattended.ts";

type G = { __pixAfk?: boolean; __pixYolo?: boolean; __pixYoloConsent?: boolean };

afterEach(() => {
	delete (globalThis as G).__pixAfk;
	delete (globalThis as G).__pixYolo;
	delete (globalThis as G).__pixYoloConsent;
});

describe("unattended mode state", () => {
	test("setMode keeps the two globals mutually exclusive", () => {
		setMode("afk");
		expect(getMode()).toBe("afk");
		expect((globalThis as G).__pixYolo).toBe(false);

		setMode("yolo");
		expect(getMode()).toBe("yolo");
		expect((globalThis as G).__pixAfk).toBe(false);

		setMode("off");
		expect(getMode()).toBe("off");
	});
});

describe("modelScore", () => {
	test("returns null for an empty / off-catalog model", () => {
		expect(modelScore({ model: undefined })).toBeNull();
		expect(modelScore({ model: { id: "definitely-not-a-real-model-xyz" } })).toBeNull();
	});
});

describe("unattendedBanner", () => {
	test("off => no banner", () => {
		setMode("off");
		expect(unattendedBanner()).toBeUndefined();
	});

	test("afk banner names auto-deny of red and root", () => {
		setMode("afk");
		const b = unattendedBanner() ?? "";
		expect(b).toContain('mode="afk"');
		expect(b).toContain("auto-DENY");
	});

	test("yolo banner demands red/root self-justification", () => {
		setMode("yolo");
		const b = unattendedBanner() ?? "";
		expect(b).toContain('mode="yolo"');
		expect(b).toContain("blast radius");
		expect(b).toContain("reversible");
	});
});

describe("YOLO score threshold", () => {
	test("is a sane capability floor", () => {
		expect(YOLO_MIN_SCORE).toBe(75);
	});
});

describe("confirmYoloConsent (session gate)", () => {
	test("short-circuits true once consent is recorded for the session", async () => {
		(globalThis as G).__pixYoloConsent = true;
		// No ui passed: if it did not short-circuit it would return false.
		expect(await confirmYoloConsent({})).toBe(true);
	});

	test("refuses when there is no ui to render the warning", async () => {
		expect(await confirmYoloConsent({})).toBe(false);
	});
});
