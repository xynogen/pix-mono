import { expect, test } from "bun:test";
import { extensionsSection } from "../../src/sections/services.ts";
import { createIsolatedRuntime } from "../../src/testing.ts";

test("extensions.disabled keeps unique strings and persists", async () => {
	const parse = (raw: unknown) => extensionsSection.__section.parse(raw, { diagnostic() {} });
	expect(parse(undefined)).toEqual({ disabled: [] });
	expect(parse({ disabled: "x" })).toEqual({ disabled: [] });
	expect(parse({ disabled: ["@xynogen/pix-footer", 3, "@xynogen/pix-footer"] })).toEqual({
		disabled: ["@xynogen/pix-footer"],
	});
	const isolated = createIsolatedRuntime();
	try {
		expect(isolated.runtime.get(extensionsSection).disabled).toEqual([]);
		await isolated.runtime.update(extensionsSection, { disabled: ["@xynogen/pix-footer"] });
		await isolated.runtime.reload();
		expect(isolated.runtime.get(extensionsSection).disabled).toEqual(["@xynogen/pix-footer"]);
	} finally {
		isolated.cleanup();
	}
});
