import { expect, test } from "bun:test";
import { createIsolatedRuntime } from "../testing.ts";
import { prettySection } from "./pretty.ts";

test("footer visibility defaults to shown and persists valid boolean choices", async () => {
	const isolated = createIsolatedRuntime();
	try {
		const { wrap, ...visibility } = isolated.runtime.get(prettySection).footer;
		expect(wrap).toBe(false);
		expect(Object.values(visibility).every(Boolean)).toBe(true);
		await isolated.runtime.update(prettySection, {
			footer: { cwd: false, model: false, wrap: true },
		});
		await isolated.runtime.reload();
		const footer = isolated.runtime.get(prettySection).footer;
		expect(footer.cwd).toBe(false);
		expect(footer.model).toBe(false);
		expect(footer.git).toBe(true);
		expect(footer.wrap).toBe(true);
		const parsed = prettySection.__section.parse(
			{ footer: { cwd: "false", git: false, wrap: "true" } },
			{ diagnostic() {} },
		);
		expect(parsed.footer.cwd).toBe(true);
		expect(parsed.footer.git).toBe(false);
		expect(parsed.footer.wrap).toBe(false);
	} finally {
		isolated.cleanup();
	}
});
