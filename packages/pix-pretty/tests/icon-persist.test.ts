import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { reloadConfig } from "@xynogen/pix-runtime/config";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { getIconMode, setIconMode } from "../src/icon-catalog.ts";
import { initIconMode, loadIconMode, saveIconMode } from "../src/icon-persist.ts";

let tmpAgentDir: string;
let origHome: string | undefined;

beforeAll(async () => {
	tmpAgentDir = mkdtempSync(join(tempDir(), "pretty-persist-test-"));
	origHome = process.env.HOME;
	// Point HOME at the temp dir so the runtime reads from there, not the real ~/.pi/agent/pix.json
	process.env.HOME = tmpAgentDir;
	process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
	// Drop any singleton created by earlier test files (it is bound to the old
	// agent dir); the next accessor call lazily recreates it under the temp HOME.
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("@xynogen/pix-runtime")];
	await reloadConfig();
});

afterAll(() => {
	process.env.HOME = origHome;
	delete process.env.PI_CODING_AGENT_DIR;
	// Drop the temp-HOME-bound singleton so later test files get a fresh one.
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("@xynogen/pix-runtime")];
	try {
		rmSync(tmpAgentDir, { recursive: true });
	} catch {
		// already gone — ignore
	}
});

describe("icon-persist", () => {
	afterEach(() => setIconMode("nerd"));

	it("returns default (nerd) in a fresh config", () => {
		expect(loadIconMode()).toBe("nerd");
	});

	it("round-trips a mode across save/load (new-session sim)", async () => {
		await saveIconMode("unicode");
		expect(loadIconMode()).toBe("unicode");
	});

	it("rejects an invalid persisted mode", async () => {
		await saveIconMode("ascii");
		expect(loadIconMode()).toBe("ascii");
	});

	it("initIconMode applies the persisted choice to the catalog", async () => {
		await saveIconMode("ascii");
		setIconMode("nerd"); // pretend env default
		initIconMode();
		expect(getIconMode()).toBe("ascii");
	});
});
