import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cacheDir, tempDir } from "@xynogen/pix-runtime/paths";
import registerClear, { outermost } from "../src/clear.ts";

// Sandbox: /clear deletes cacheDir() and <tempDir>/jiti. Never let a test reach the real ones.
let sandbox: string;
let tmp: string;
// tempDir() reads TMPDIR on POSIX and TEMP/TMP on Windows. Point all three at the sandbox.
const TMP_VARS = ["TMPDIR", "TEMP", "TMP"] as const;
const saved = Object.fromEntries(["XDG_CACHE_HOME", ...TMP_VARS].map((k) => [k, process.env[k]]));
beforeEach(() => {
	sandbox = mkdtempSync(join(tempDir(), "pix-clear-"));
	process.env.XDG_CACHE_HOME = sandbox;
	tmp = join(sandbox, "tmp");
	for (const k of TMP_VARS) process.env[k] = tmp;
	expect(tempDir()).toBe(tmp);
	mkdirSync(cacheDir(), { recursive: true });
	mkdirSync(join(tmp, "jiti"), { recursive: true });
	writeFileSync(join(tmp, "other-app.sock"), "");
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(sandbox, { recursive: true, force: true });
});

function handler() {
	let run: ((args: string, ctx: never) => Promise<void>) | undefined;
	registerClear({
		registerCommand(_name: string, opts: { handler: typeof run }) {
			run = opts.handler;
		},
	} as unknown as ExtensionAPI);
	if (!run) throw new Error("/clear was not registered");
	return run;
}

const theme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
};

/** Fake UI: renders the confirm overlay once, then answers `answer`. */
function ctx(answer: boolean) {
	const notes: string[] = [];
	let body = "";
	const c = {
		hasUI: true,
		ui: {
			notify: (m: string) => notes.push(m),
			custom: async (factory: (...a: unknown[]) => { render(w: number): string[] }) => {
				const tui = { requestRender() {}, terminal: { rows: 40 } };
				body = factory(tui, theme, { matches: () => false }, () => {})
					.render(100)
					.join("\n");
				return answer;
			},
		},
	};
	return { c, notes, body: () => body };
}

describe("/clear", () => {
	test("asks first, names the target dir, and deletes nothing on cancel", async () => {
		const { c, notes, body } = ctx(false);
		await handler()("", c as never);
		expect(body()).toMatch(/Clear the Pi cache\?[\s\S]*This deletes:[\s\S]*Delete[\s\S]*Cancel/);
		expect(body()).toContain(cacheDir());
		expect(existsSync(cacheDir())).toBe(true);
		expect(notes).toEqual(["Clear cancelled."]);
	});

	test("deletes the cache dir after confirm", async () => {
		const { c, notes } = ctx(true);
		await handler()("", c as never);
		expect(existsSync(cacheDir())).toBe(false);
		expect(existsSync(join(tmp, "jiti"))).toBe(false);
		// Regression: other programs' temp files must survive.
		expect(existsSync(join(tmp, "other-app.sock"))).toBe(true);
		expect(notes.at(-1)).toMatch(/cleared\. Run \/reload/);
	});
});

describe("outermost", () => {
	test("lists a nested target once, under its parent", () => {
		const base = tempDir();
		const cache = join(base, "cache");
		expect(outermost([cache, join(cache, "jiti")])).toEqual([cache]);
		expect(outermost([cache, join(base, "jiti")])).toEqual([cache, join(base, "jiti")]);
	});
});
