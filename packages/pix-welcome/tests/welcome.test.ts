import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	colorToHex,
	stripTerminalSequences,
	styleText,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ConfirmUI } from "@xynogen/pix-pretty/confirm";
import { runGit } from "@xynogen/pix-runtime/os";
import { tempDir } from "@xynogen/pix-runtime/paths";
import registerWelcome, {
	appendIgnoreRules,
	type CheckResult,
	checkPiIgnore,
	countSkillsInDirs,
	LABEL_WIDTH,
	LOGO_ROWS,
	PI_IGNORE_RULES,
	renderCheck,
	renderWelcome,
	shortCwd,
	statusIcon,
	summariseSkills,
	summariseTools,
	type Theme,
} from "../src/welcome.ts";

const theme: Theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

describe("welcome lifecycle", () => {
	it.each([
		"0.7.23",
		"",
	])("uses the header with bundle version %j, dismisses on the first turn, and skips reload", (version) => {
		let onStart: ((event: { reason: "reload" | "new" }, ctx: unknown) => void) | undefined;
		let onTurn: typeof onStart;
		let renderHeader: ((width: number) => string[]) | undefined;
		let headerCalls = 0;
		const events = new EventEmitter();
		if (version)
			events.on("pix:core-version", (query) => {
				query.version = version;
			});
		registerWelcome({
			events,
			on(event: string, handler: typeof onStart) {
				if (event === "session_start") onStart = handler;
				if (event === "turn_start") onTurn = handler;
			},
		} as never);
		onStart?.(
			{ reason: "reload" },
			{
				ui: { setHeader: () => headerCalls++ },
				cwd: tempDir(),
				modelRegistry: { getAvailable: () => [] },
			},
		);
		expect(headerCalls).toBe(0);
		onStart?.(
			{ reason: "new" },
			{
				ui: {
					setHeader(
						factory: (
							tui: { requestRender(): void },
							theme: Theme,
						) => {
							render(width: number): string[];
						},
					) {
						headerCalls++;
						renderHeader = factory({ requestRender() {} }, theme).render;
					},
				},
				cwd: tempDir(),
				modelRegistry: { getAvailable: () => [] },
			},
		);
		expect(headerCalls).toBe(1);
		expect(renderHeader?.(120)?.[1]).toMatch(/^ {3}.+ {2}Welcome, .+!$/);
		expect(renderHeader?.(120)?.[2]).toBe(
			`   ${LOGO_ROWS[1]?.[0]}  PIx${version ? ` ${version}` : ""}`,
		);
		onTurn?.({ reason: "new" }, {});
		expect(renderHeader?.(80)).toEqual([]);
	});
});

describe("renderWelcome", () => {
	const checks: CheckResult[] = [{ label: "PI", status: "ok", detail: "1.0.0" }];
	it("clamps every line to the given width so a wide logo can't crash the TUI", () => {
		const lines = renderWelcome(theme, "some-model", "/very/long/path", checks, 10);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(10);
	});
	it("passes empty lines through untouched", () => {
		const lines = renderWelcome(theme, "m", "/p", checks, 40);
		expect(lines.some((l) => l === "")).toBe(true);
	});
	it("shows the supplied pix-core version beside PIx and preserves the PI check", () => {
		const lines = renderWelcome(theme, "m", "/p", checks, 120, "", "0.7.22");
		expect(lines[2]).toBe(`   ${LOGO_ROWS[1]?.[0]}  PIx 0.7.22`);
		expect(lines[7]).toMatch(/PI\s+1\.0\.0$/);
		for (const line of renderWelcome(theme, "m", "/p", checks, 32, "", "0.7.22")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(32);
		}
	});
	it("uses the accent for username, PIx version, model and path", () => {
		const calls: Array<[string, string]> = [];
		const recordingTheme: Theme = {
			fg: (color, text) => {
				calls.push([color, text]);
				return text;
			},
			bold: (text) => text,
		};
		renderWelcome(recordingTheme, "model", "~/project", [], 120, "alice", "0.7.23");
		expect(calls).toEqual([
			["dim", "Welcome,"],
			["accent", "alice"],
			["dim", "!"],
			["dim", "PIx"],
			["accent", "0.7.23"],
			["muted", expect.any(String)],
			["accent", "model"],
			["muted", expect.any(String)],
			["accent", "~/project"],
			["success", expect.any(String)],
			["success", "ready"],
		]);
	});
});

it("greets the supplied OS username and clips long names to the terminal width", () => {
	const lines = renderWelcome(theme, "model", "cwd", [], 120, "alice");
	expect(lines.slice(1, 3)).toEqual([
		`   ${LOGO_ROWS[0]?.[0]}  Welcome, alice!`,
		`   ${LOGO_ROWS[1]?.[0]}  PIx`,
	]);
	for (const width of [0, 1, 20, 40, 80]) {
		for (const line of renderWelcome(theme, "model", "cwd", [], width, "界alice".repeat(40))) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	}
});

it("matches the README mosaic geometry and colors cell for cell", () => {
	const svg = readFileSync(
		new URL("../../../.github/assets/pix-logo.svg", import.meta.url),
		"utf8",
	);
	const expected = Array.from({ length: 5 }, () => Array<string | undefined>(12).fill(undefined));
	const pieces = [
		...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="(#[a-f0-9]+)"/g),
	];
	expect(pieces).toHaveLength(18);
	for (const piece of pieces) {
		const [x, y, w, h] = piece.slice(1, 5).map(Number) as [number, number, number, number];
		for (const value of [x, y, w, h]) expect(value % 20).toBe(0);
		for (let row = y / 20; row < (y + h) / 20; row++) {
			for (let col = x / 20; col < (x + w) / 20; col++) {
				expect(expected[row]![col]).toBeUndefined();
				expected[row]![col] = piece[5];
			}
		}
	}
	const actual: string[] = [];
	const coloredTheme: Theme = {
		...theme,
		style(text, style) {
			expect(text).toBe("██");
			if (!style.fg) throw new Error("Logo cell has no foreground color");
			actual.push(colorToHex(style.fg));
			return styleText(text, style, "truecolor");
		},
	};
	const lines = renderWelcome(coloredTheme, "model", "cwd", [], 120);
	expect(actual).toEqual(expected.flat().filter((color): color is string => color !== undefined));
	for (let row = 0; row < 5; row++) {
		const mask = expected[row]!.map((color) => (color ? "██" : "  ")).join("");
		expect(LOGO_ROWS[row]![0]).toBe(mask);
		expect(stripTerminalSequences(lines[row + 1]!).slice(3, 27)).toBe(mask);
	}
	for (const [start, end] of [
		[0, 4],
		[4, 7],
		[7, 12],
	] as const) {
		expect(
			expected.flatMap((row) => row.slice(start, end)).filter((c) => c === "#9d7cd8"),
		).toHaveLength(1);
	}
	for (const width of [0, 1, 10, 27, 40, 80]) {
		for (const line of renderWelcome(coloredTheme, "model", "cwd", [], width)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	}
});

describe("shortCwd", () => {
	it("replaces home prefix with ~", () => {
		expect(shortCwd("/home/user/projects/foo", "/home/user")).toBe("~/projects/foo");
	});

	it("returns path unchanged when not under home", () => {
		expect(shortCwd("/tmp/foo", "/home/user")).toBe("/tmp/foo");
	});

	it("handles exact home match", () => {
		expect(shortCwd("/home/user", "/home/user")).toBe("~");
	});

	it("uses empty string home gracefully", () => {
		expect(shortCwd("/tmp/foo", "")).toBe("/tmp/foo");
	});
});

describe("statusIcon", () => {
	it("returns ○ for pending", () => {
		expect(statusIcon(theme, "pending")).toContain("○");
	});
	it("returns ✓ for ok", () => {
		expect(statusIcon(theme, "ok")).toContain("✓");
	});
	it("returns ⚠ for warn", () => {
		expect(statusIcon(theme, "warn")).toContain("⚠");
	});
	it("returns ✗ for error", () => {
		expect(statusIcon(theme, "error")).toContain("✗");
	});
});

describe("renderCheck", () => {
	it("includes icon, label, and detail", () => {
		const check: CheckResult = { label: "PIx", status: "ok", detail: "0.76.0" };
		const rendered = renderCheck(theme, check);
		expect(rendered).toContain("✓");
		expect(rendered).toContain("PIx");
		expect(rendered).toContain("0.76.0");
	});

	it("pads label to LABEL_WIDTH", () => {
		const check: CheckResult = { label: "PIx", status: "ok", detail: "x" };
		const rendered = renderCheck(theme, check);
		expect(rendered).toContain("PIx".padEnd(LABEL_WIDTH));
	});

	it("renders without detail when absent", () => {
		const check: CheckResult = { label: "Auth", status: "warn" };
		const rendered = renderCheck(theme, check);
		expect(rendered).toContain("⚠");
		expect(rendered).toContain("Auth");
	});

	it("uses status color, secondary label, and primary detail", () => {
		const calls: Array<{ color: string; text: string }> = [];
		const recordingTheme: Theme = {
			fg: (color, text) => {
				calls.push({ color, text });
				return text;
			},
			bold: (text) => text,
		};
		renderCheck(recordingTheme, { label: "Auth", status: "ok", detail: "connected" });
		expect(calls).toEqual([
			{ color: "success", text: "✓" },
			{ color: "dim", text: "Auth  " },
			{ color: "accent", text: "connected" },
		]);
	});
	it("colors warning and error details with their status role", () => {
		const taggedTheme: Theme = {
			fg: (color, text) => `<${color}>${text}</${color}>`,
			bold: (text) => text,
		};
		for (const [status, role] of [
			["warn", "warning"],
			["error", "error"],
		] as const) {
			expect(renderCheck(taggedTheme, { label: "Auth", status, detail: "unavailable" })).toBe(
				`<${role}>${status === "warn" ? "⚠" : "✗"}</${role}> <${role}>Auth  </${role}>  <${role}>unavailable</${role}>`,
			);
		}
	});
});

describe("LOGO_ROWS", () => {
	it("has 5 grid rows", () => expect(LOGO_ROWS.length).toBe(5));
	it("starts with welcome tag", () => expect(LOGO_ROWS[0]?.[1]).toBe("welcome"));
	it("has heading, model, cwd, ready tags", () => {
		const tags = LOGO_ROWS.map((r) => r[1]);
		expect(tags).toContain("heading");
		expect(tags).toContain("model");
		expect(tags).toContain("cwd");
		expect(tags).toContain("ready");
	});
});

describe("summariseTools", () => {
	it("warns when no tools are active", () => {
		const r = summariseTools([]);
		expect(r.status).toBe("warn");
		expect(r.detail).toBe("none active");
	});

	it("counts builtin-only tools without ext suffix", () => {
		const r = summariseTools([
			{ sourceInfo: { source: "builtin" } },
			{ sourceInfo: { source: "builtin" } },
		]);
		expect(r.status).toBe("ok");
		expect(r.detail).toBe("2 loaded");
	});

	it("counts total without source breakdown", () => {
		const r = summariseTools([
			{ sourceInfo: { source: "builtin" } },
			{ sourceInfo: { source: "my-extension" } },
			{ sourceInfo: { source: "sdk" } },
		]);
		expect(r.detail).toBe("3 loaded");
	});
});

describe("summariseSkills", () => {
	it("warns when no skills loaded", () => {
		const r = summariseSkills([]);
		expect(r.status).toBe("warn");
		expect(r.detail).toBe("none loaded");
	});

	it("reports count when all skills are auto-invocable", () => {
		const r = summariseSkills([{}, {}, {}]);
		expect(r.status).toBe("ok");
		expect(r.detail).toBe("3 loaded");
	});

	it("notes manual skills in detail", () => {
		const r = summariseSkills([{}, { disableModelInvocation: true }, {}]);
		expect(r.status).toBe("ok");
		expect(r.detail).toBe("3 loaded (+1 manual)");
	});

	it("marks all-manual as manual", () => {
		const r = summariseSkills([{ disableModelInvocation: true }, { disableModelInvocation: true }]);
		expect(r.status).toBe("ok");
		expect(r.detail).toBe("2 loaded (manual)");
	});
});

describe("countSkillsInDirs", () => {
	it("returns 0 for nonexistent dirs", () => {
		expect(countSkillsInDirs(["/nonexistent/path/xyz"])).toBe(0);
	});

	it("counts flat .md files", () => {
		const dir = mkdtempSync(join(tempDir(), "pix-skills-"));
		try {
			writeFileSync(join(dir, "commit.md"), "---\nname: commit\ndescription: test\n---\n");
			writeFileSync(join(dir, "debug.md"), "---\nname: debug\ndescription: test\n---\n");
			expect(countSkillsInDirs([dir])).toBe(2);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("counts subdir SKILL.md layout", () => {
		const dir = mkdtempSync(join(tempDir(), "pix-skills-"));
		try {
			mkdirSync(join(dir, "my-skill"));
			writeFileSync(
				join(dir, "my-skill", "SKILL.md"),
				"---\nname: my-skill\ndescription: test\n---\n",
			);
			expect(countSkillsInDirs([dir])).toBe(1);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("deduplicates across dirs", () => {
		const dir = mkdtempSync(join(tempDir(), "pix-skills-"));
		try {
			writeFileSync(join(dir, "foo.md"), "---\nname: foo\ndescription: test\n---\n");
			// same dir twice — should still count 1
			expect(countSkillsInDirs([dir, dir])).toBe(1);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});

describe("PI_IGNORE_RULES", () => {
	it("includes only the current Pi directory", () => {
		expect(PI_IGNORE_RULES).toEqual([".pi/"]);
	});
});

describe("appendIgnoreRules", () => {
	it("keeps every user line after an existing Pix header", () => {
		const before = "node_modules/\n# Pix Agent\n.old/\ndist/\n*.log\n";
		const after = appendIgnoreRules(before, [".pi/"]);
		expect(after).toBe("node_modules/\n# Pix Agent\n.pi/\n.old/\ndist/\n*.log\n");
	});

	it("keeps CRLF line endings", () => {
		expect(appendIgnoreRules("dist/\r\n", [".pi/"])).toBe("dist/\r\n\r\n# Pix Agent\r\n.pi/\r\n");
	});

	it("adds a newline before the block when the file lacks one", () => {
		expect(appendIgnoreRules("dist/", [".pi/"])).toBe("dist/\n\n# Pix Agent\n.pi/\n");
	});

	it("writes only the block into an empty file", () => {
		expect(appendIgnoreRules("", [".pi/"])).toBe("# Pix Agent\n.pi/\n");
	});
});

describe("checkPiIgnore", () => {
	async function repo(gitignore: string): Promise<string> {
		const dir = mkdtempSync(join(tempDir(), "pix-welcome-ignore-"));
		await runGit(["init", "-q"], { cwd: dir, timeoutMs: 5_000 });
		writeFileSync(join(dir, ".gitignore"), gitignore);
		return dir;
	}

	it.each([true, false])("uses a startup overlay with decision %j", async (confirmed) => {
		const dir = await repo("dist/\n");
		try {
			let onStart: ((event: { reason: "new" }, ctx: unknown) => void) | undefined;
			let renderHeader: ((width: number) => string[]) | undefined;
			let finish!: () => void;
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const overlays: string[] = [];
			const custom: ConfirmUI["custom"] = async (factory, options) => {
				expect(options).toMatchObject({ overlay: true });
				const component = factory(
					{ requestRender() {}, terminal: { rows: 50 } },
					{ ...theme, bg: (_color, text) => text },
					{} as never,
					() => {},
				);
				overlays.push(component.render(120).join("\n"));
				return confirmed as never;
			};
			registerWelcome({
				on(event: string, handler: typeof onStart) {
					if (event === "session_start") onStart = handler;
				},
			} as never);
			onStart?.(
				{ reason: "new" },
				{
					cwd: dir,
					hasUI: true,
					modelRegistry: { getAvailable: () => [] },
					ui: {
						custom,
						setHeader(
							factory: (
								tui: { requestRender(): void },
								theme: Theme,
							) => { render(width: number): string[] },
						) {
							renderHeader = factory(
								{
									requestRender() {
										if (
											/Ignore\s+(1 added|skipped \(declined\))/.test(
												renderHeader?.(120).join("\n") ?? "",
											)
										)
											finish();
									},
								},
								theme,
							).render;
						},
					},
				},
			);
			await finished;
			expect(overlays).toHaveLength(1);
			expect(overlays[0]).toContain("Add .pi/ to .gitignore?");
			expect(overlays[0]).toContain(`${dir.replace(/\\/g, "/")}/.gitignore`);
			expect(overlays[0]).toMatch(/# Pix Agent[\s\S]*\.pi\/[\s\S]*Asked once per repo\./);
			expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
				confirmed ? "dist/\n\n# Pix Agent\n.pi/\n" : "dist/\n",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("edits only after the user confirms, and keeps user rules", async () => {
		const dir = await repo("# Pix Agent\nsecret.env\n");
		try {
			const asked: string[] = [];
			const result = await checkPiIgnore(dir, async (title) => {
				asked.push(title);
				return true;
			});
			expect(asked).toEqual(["Add .pi/ to .gitignore?"]);
			expect(result).toMatchObject({ status: "ok", detail: "1 added" });
			expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("# Pix Agent\n.pi/\nsecret.env\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("remembers a decline and does not ask again", async () => {
		const dir = await repo("dist/\n");
		try {
			let asks = 0;
			const no = async () => {
				asks++;
				return false;
			};
			expect(await checkPiIgnore(dir, no)).toMatchObject({ detail: "skipped (declined)" });
			expect(await checkPiIgnore(dir, no)).toMatchObject({ detail: "skipped (declined)" });
			expect(asks).toBe(1);
			expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("dist/\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never edits without a UI", async () => {
		const dir = await repo("dist/\n");
		try {
			expect(await checkPiIgnore(dir)).toMatchObject({
				status: "warn",
				detail: ".pi/ not ignored",
			});
			expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("dist/\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
