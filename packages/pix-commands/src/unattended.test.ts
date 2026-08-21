import { describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	confirmYoloConsent,
	getMode,
	modelScore,
	setMode,
	unattendedBanner,
	YOLO_MIN_SCORE,
} from "./unattended.ts";

describe("unattended mode state", () => {
	test("setMode updates one session", () => {
		const events = createEventBus();
		setMode(events, "afk");
		expect(getMode(events)).toBe("afk");

		setMode(events, "yolo");
		expect(getMode(events)).toBe("yolo");

		setMode(events, "off");
		expect(getMode(events)).toBe("off");
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
		const events = createEventBus();
		setMode(events, "off");
		expect(unattendedBanner(events)).toBeUndefined();
	});

	test("afk banner names auto-deny of red and root", () => {
		const events = createEventBus();
		setMode(events, "afk");
		const b = unattendedBanner(events) ?? "";
		expect(b).toContain('mode="afk"');
		expect(b).toContain("auto-DENY");
	});

	test("yolo banner demands red/root self-justification", () => {
		const events = createEventBus();
		setMode(events, "yolo");
		const b = unattendedBanner(events) ?? "";
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
		const events = createEventBus();
		const { setYoloConsent } = await import("@xynogen/pix-runtime");
		setYoloConsent(events, true);
		// No ui passed: if it did not short-circuit it would return false.
		expect(await confirmYoloConsent(events, {})).toBe(true);
	});

	test("refuses when there is no ui to render the warning", async () => {
		expect(await confirmYoloConsent(createEventBus(), {})).toBe(false);
	});
});
