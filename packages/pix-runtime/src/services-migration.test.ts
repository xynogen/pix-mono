import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchSection, toolboxSection, voiceSection } from "./sections/index.ts";
import { createIsolatedRuntime } from "./testing.ts";

test("service migration preserves canonical values and archives old files after saving", async () => {
	const isolated = createIsolatedRuntime();
	try {
		writeFileSync(
			join(isolated.agentDir, "pix.json"),
			JSON.stringify({ $version: 1, fetch: { provider: "curl" } }),
		);
		writeFileSync(
			join(isolated.agentDir, "fetch.json"),
			JSON.stringify({ provider: "9router", nineRouterModel: "custom" }),
		);
		writeFileSync(
			join(isolated.agentDir, "voice.json"),
			JSON.stringify({ sttProvider: "groq", ttsPlay: false }),
		);
		writeFileSync(
			join(isolated.agentDir, "toolbox.json"),
			JSON.stringify({ disabledTools: ["fetch"] }),
		);
		await isolated.runtime.init();
		expect(isolated.runtime.get(fetchSection)).toEqual({
			provider: "curl",
			nineRouterModel: "custom",
		});
		expect(isolated.runtime.get(voiceSection)).toMatchObject({
			sttProvider: "groq",
			ttsPlay: false,
		});
		expect(isolated.runtime.get(toolboxSection).disabledTools).toEqual(["fetch"]);
		for (const section of ["fetch", "voice", "toolbox"]) {
			expect(existsSync(join(isolated.agentDir, `${section}.json.migrated-v1`))).toBe(true);
		}
		const disk = JSON.parse(readFileSync(join(isolated.agentDir, "pix.json"), "utf8"));
		expect(disk.voice.sttProvider).toBe("groq");
	} finally {
		isolated.cleanup();
	}
});
