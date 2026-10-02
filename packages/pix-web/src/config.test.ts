import { expect, test } from "bun:test";
import { createIsolatedRuntime } from "@xynogen/pix-runtime/testing";
import { loadFetchConfig, saveFetchConfig } from "./config.ts";

test("fetch settings persist in unified config", async () => {
	const isolated = createIsolatedRuntime();
	try {
		expect(loadFetchConfig(isolated.runtime)).toEqual({ provider: "auto", nineRouterModel: "exa" });
		await saveFetchConfig({ provider: "9router", nineRouterModel: "custom" }, isolated.runtime);
		await isolated.runtime.reload();
		expect(loadFetchConfig(isolated.runtime)).toEqual({
			provider: "9router",
			nineRouterModel: "custom",
		});
	} finally {
		isolated.cleanup();
	}
});
