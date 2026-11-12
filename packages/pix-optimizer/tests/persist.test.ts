/**
 * Optimizer states persist in pix.json `optimizer` (pix-runtime), surviving a
 * full quit/restart, and never recreate the retired `optimizer.json` sidecar.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@xynogen/pix-runtime/paths";

let tmpAgentDir: string;
let persist: typeof import("../src/persist.ts");

beforeAll(async () => {
	tmpAgentDir = mkdtempSync(join(tempDir(), "optimizer-persist-test-"));
	// The runtime singleton binds its agent dir on first use; set it first.
	process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
	persist = await import("../src/persist.ts");
	const { pixRuntime } = await import("@xynogen/pix-runtime/config");
	await pixRuntime().init();
});

afterAll(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(tmpAgentDir, { recursive: true, force: true });
});

const pixJson = () => JSON.parse(readFileSync(join(tmpAgentDir, "pix.json"), "utf-8"));

describe("optimizer persistence (pix.json)", () => {
	test("defaults before anything is saved", () => {
		expect(persist.loadOptValue("caveman")).toBe("off");
		expect(persist.loadOptValue("rtk")).toBe("on");
	});

	test("round-trips each tool independently into pix.json.optimizer", async () => {
		await persist.saveOptValue("caveman", "lite");
		await persist.saveOptValue("ponytail", "full");
		await persist.saveOptValue("rtk", "off");
		expect(persist.loadOptValue("caveman")).toBe("lite");
		expect(persist.loadOptValue("ponytail")).toBe("full");
		expect(persist.loadOptValue("rtk")).toBe("off");
		expect(pixJson().optimizer).toMatchObject({ caveman: "lite", ponytail: "full", rtk: "off" });
	});

	test("never writes the retired optimizer.json sidecar", () => {
		expect(existsSync(join(tmpAgentDir, "optimizer.json"))).toBe(false);
	});
});
