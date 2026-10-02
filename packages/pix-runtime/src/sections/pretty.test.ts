import { expect, test } from "bun:test";
import { createIsolatedRuntime } from "../testing.ts";
import { prettySection } from "./pretty.ts";

test("footer visibility defaults to shown and persists valid boolean choices", async () => {
	const isolated = createIsolatedRuntime();
	try {
		expect(Object.values(isolated.runtime.get(prettySection).footer).every(Boolean)).toBe(true);
		await isolated.runtime.update(prettySection, { footer: { cwd: false, model: false } });
		await isolated.runtime.reload();
		const footer = isolated.runtime.get(prettySection).footer;
		expect(footer.cwd).toBe(false);
		expect(footer.model).toBe(false);
		expect(footer.git).toBe(true);
		const parsed = prettySection.__section.parse(
			{ footer: { cwd: "false", git: false } },
			{ diagnostic() {} },
		);
		expect(parsed.footer.cwd).toBe(true);
		expect(parsed.footer.git).toBe(false);
	} finally {
		isolated.cleanup();
	}
});
