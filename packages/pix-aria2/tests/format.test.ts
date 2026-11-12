import { describe, expect, test } from "bun:test";
import { type DlStatus, downloadName, etaSeconds, fraction, progressLine } from "../src/format.ts";

function status(over: Partial<DlStatus> = {}): DlStatus {
	return {
		gid: "abc123",
		status: "active",
		totalLength: "1000",
		completedLength: "250",
		downloadSpeed: "100",
		...over,
	};
}

describe("fraction", () => {
	test("computes completion ratio", () => {
		expect(fraction(status())).toBeCloseTo(0.25);
	});
	test("returns 0 for unknown total", () => {
		expect(fraction(status({ totalLength: "0" }))).toBe(0);
	});
	test("clamps to 1", () => {
		expect(fraction(status({ completedLength: "2000" }))).toBe(1);
	});
});

describe("etaSeconds", () => {
	test("remaining / speed", () => {
		// (1000-250)/100 = 7.5 -> ceil 8
		expect(etaSeconds(status())).toBe(8);
	});
	test("undefined when stalled or done", () => {
		expect(etaSeconds(status({ downloadSpeed: "0" }))).toBeUndefined();
		expect(etaSeconds(status({ completedLength: "1000" }))).toBeUndefined();
	});
});

describe("downloadName", () => {
	test("prefers file basename", () => {
		expect(downloadName(status({ files: [{ path: "/tmp/dl/video.mp4" }] }))).toBe("video.mp4");
	});
	test("falls back to URI basename", () => {
		expect(
			downloadName(status({ files: [{ uris: [{ uri: "https://x.com/a/b/file.iso" }] }] })),
		).toBe("file.iso");
	});
	test("falls back to gid", () => {
		expect(downloadName(status({ files: [] }))).toBe("abc123");
	});
});

describe("progressLine", () => {
	test("assembles a readable line", () => {
		const line = progressLine("dl-swift-otter-42", status({ files: [{ path: "/d/movie.mkv" }] }));
		const parts = line.split(" · ");
		expect(parts).toHaveLength(5);
		expect(parts[0]).toBe("dl-swift-otter-42 movie.mkv");
		expect(parts[1]).toMatch(/^\d+%$/);
		expect(parts[2]).toMatch(/^\S+ B\/\S+ B$/);
		expect(parts[3]).toEndWith("/s");
		expect(parts[4]).toStartWith("eta ");
	});
	test("omits speed/eta when stalled", () => {
		const line = progressLine(
			"dl-x-y-01",
			status({ downloadSpeed: "0", files: [{ path: "/a.bin" }] }),
		);
		expect(line).toContain("25%");
		expect(line).not.toContain("/s");
		expect(line).not.toContain("eta");
	});
});
