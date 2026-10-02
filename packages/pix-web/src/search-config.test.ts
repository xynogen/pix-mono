import { expect, test } from "bun:test";
import { createIsolatedRuntime } from "@xynogen/pix-runtime/testing";
import { loadSearchConfig, saveSearchConfig } from "./search-config.ts";

test("search settings persist in unified config", async () => {
	const isolated = createIsolatedRuntime();
	try {
		expect(loadSearchConfig(isolated.runtime)).toEqual({
			provider: "auto",
			nineRouterModel: "exa",
		});
		await saveSearchConfig({ provider: "9router", nineRouterModel: "custom" }, isolated.runtime);
		await isolated.runtime.reload();
		expect(loadSearchConfig(isolated.runtime)).toEqual({
			provider: "9router",
			nineRouterModel: "custom",
		});
	} finally {
		isolated.cleanup();
	}
});
