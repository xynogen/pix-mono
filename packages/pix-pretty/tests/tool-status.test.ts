import { describe, expect, test } from "bun:test";
import {
	formatToolStatus,
	reportToolStatus,
	resetBinaryWarnings,
	warnBinaryMissing,
} from "../src/tool-status.ts";

function fakeUi() {
	const status: Array<[string, string | undefined]> = [];
	const widgets: Array<string | undefined> = [];
	const theme = { fg: (c: string, t: string) => `<${c}>${t}` };
	return {
		status,
		widgets,
		ui: {
			setStatus: (k: string, t: string | undefined) => status.push([k, t]),
			setWidget: (_k: string, f: unknown) => {
				const w =
					typeof f === "function"
						? (f as (a: unknown, t: typeof theme) => { render(n: number): string[] })(null, theme)
						: undefined;
				widgets.push(w?.render(200).join("\n"));
			},
		},
	};
}

describe("tool-status", () => {
	test("downloading → footer status + info line with version, size and source", () => {
		const f = fakeUi();
		reportToolStatus(f.ui)({
			kind: "downloading",
			name: "rtk",
			version: "0.50.0",
			url: "https://github.com/rtk-ai/rtk/x.zip",
			size: "~5 MB",
		});
		expect(f.status[0]?.[0]).toBe("pix-binaries");
		expect(f.status[0]?.[1]).toMatch(/rtk 0\.50\.0$/);
		expect(f.widgets[0]).toMatch(
			/<accent>info<muted> · <dim>downloading rtk 0\.50\.0 \(~5 MB\) from https:\/\/github\.com\/rtk-ai/,
		);
	});

	test("installed clears the status (info); failed clears it (warning) with the hint", () => {
		const f = fakeUi();
		const report = reportToolStatus(f.ui);
		report({ kind: "installed", name: "hunk", path: "/b/hunk", version: "0.22.0", verified: true });
		report({ kind: "failed", name: "hunk", error: "HTTP 404", hint: "npm i -g hunkdiff" });
		expect(f.status).toEqual([
			["pix-binaries", undefined],
			["pix-binaries", undefined],
		]);
		expect(f.widgets[0]).toMatch(
			/<accent>info<muted> · <dim>installed hunk 0\.22\.0 → \/b\/hunk \(sha256 verified\)/,
		);
		expect(f.widgets[1]).toMatch(
			/<warning>warning<muted> · <dim>hunk unavailable: HTTP 404 — install: npm i -g hunkdiff/,
		);
	});

	test("formatToolStatus omits empty size/hint", () => {
		expect(formatToolStatus({ kind: "downloading", name: "a", version: "1", url: "u" })).toBe(
			"downloading a 1 from u",
		);
		expect(formatToolStatus({ kind: "failed", name: "a", error: "e", hint: "" })).toBe(
			"a unavailable: e",
		);
	});
});

describe("warnBinaryMissing", () => {
	const missing = Object.assign(new Error("ssh not found — install: enable OpenSSH"), {
		name: "BinaryMissingError",
		tool: "ssh",
	});

	test("one warning per tool, naming the /pix Binaries tab", () => {
		resetBinaryWarnings();
		const f = fakeUi();
		expect(warnBinaryMissing(f.ui, missing)).toBe(true);
		expect(warnBinaryMissing(f.ui, missing)).toBe(true);
		expect(f.widgets.filter(Boolean)).toHaveLength(1);
		expect(f.widgets[0]).toMatch(
			/<warning>.*ssh not found — install: .* · set a path in \/pix → Binaries/,
		);
	});

	test("other errors are left to the caller", () => {
		expect(warnBinaryMissing(fakeUi().ui, new Error("boom"))).toBe(false);
	});
});
