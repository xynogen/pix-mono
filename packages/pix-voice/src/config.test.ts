import { expect, test } from "bun:test";
import { createIsolatedRuntime } from "@xynogen/pix-runtime/testing";
import { loadConfig, parseLanguage, saveConfig } from "./config.ts";

test("voice settings persist in unified config", async () => {
	const isolated = createIsolatedRuntime();
	try {
		const settings = loadConfig(isolated.runtime);
		expect(settings).toMatchObject({ sttProvider: "auto", ttsPlay: true, sttCleanup: "off" });
		settings.sttProvider = "groq";
		settings.sttNineRouterModel = "dg/nova-2";
		await saveConfig(settings, isolated.runtime);
		await isolated.runtime.reload();
		expect(loadConfig(isolated.runtime)).toMatchObject({
			sttProvider: "groq",
			sttNineRouterModel: "dg/nova-2",
		});
	} finally {
		isolated.cleanup();
	}
});

test("language validation accepts codes and rejects names", () => {
	expect(parseLanguage(" EN ")).toBe("en");
	expect(parseLanguage("pt-BR")).toBe("pt-br");
	expect(parseLanguage("")).toBe("auto");
	expect(() => parseLanguage("English")).toThrow(/not a language code/);
});
