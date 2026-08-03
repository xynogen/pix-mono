/**
 * Regression test for the cross-session reset bug: optimizer tool states
 * (caveman/ponytail/rtk) were lost on a full quit/restart because they
 * only persisted to the session log. persist.ts adds disk persistence so a
 * value written in one session is readable in the next.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOptValue, saveOptValue } from "./persist.ts";

let tmpAgentDir: string;

beforeAll(() => {
	tmpAgentDir = mkdtempSync(join(tmpdir(), "optimizer-persist-test-"));
	process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
});

afterAll(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	try {
		rmSync(tmpAgentDir, { recursive: true });
	} catch {
		// temp dir may already be gone — safe to ignore
	}
});

describe("optimizer persistence", () => {
	test("returns undefined before anything is saved", () => {
		expect(loadOptValue("caveman")).toBeUndefined();
	});

	test("round-trips a single tool value across save/load (new-session sim)", () => {
		saveOptValue("caveman", "lite");
		// A fresh load (as a new session would do) sees the persisted value.
		expect(loadOptValue("caveman")).toBe("lite");
	});

	test("persists each tool independently in one shared file", () => {
		saveOptValue("ponytail", "full");
		saveOptValue("rtk", "off");
		expect(loadOptValue("caveman")).toBe("lite");
		expect(loadOptValue("ponytail")).toBe("full");
		expect(loadOptValue("rtk")).toBe("off");
	});

	test("overwriting one tool leaves the others intact", () => {
		saveOptValue("caveman", "ultra");
		expect(loadOptValue("caveman")).toBe("ultra");
		expect(loadOptValue("ponytail")).toBe("full");
	});

	test("drops legacy TOON state on the next write", () => {
		const statePath = join(tmpAgentDir, "optimizer.json");
		writeFileSync(statePath, JSON.stringify({ caveman: "lite", toon: "on" }));

		saveOptValue("rtk", "on");

		expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual({
			caveman: "lite",
			rtk: "on",
		});
	});
});
