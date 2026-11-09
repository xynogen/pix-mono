import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setUnattendedMode } from "@xynogen/pix-runtime";
import { tempDir } from "@xynogen/pix-runtime/paths";
import register from "./extension.ts";

test("nuclear skips env write, read, and injection approval while retaining validation", async () => {
	const cwd = mkdtempSync(join(tempDir(), "pix-env-nuclear-"));
	const previousCwd = process.cwd();
	const events = createEventBus();
	let tool: any;
	let inject: any;
	register({
		events,
		registerTool(t: any) {
			tool = t;
		},
		on(name: string, fn: any) {
			if (name === "tool_call") inject = fn;
		},
	} as unknown as ExtensionAPI);
	setUnattendedMode(events, "nuclear");
	const ctx = { cwd, hasUI: false };
	try {
		process.chdir(cwd);
		writeFileSync(join(cwd, ".env"), "TOKEN=fixture-secret\n");
		const write = await tool.execute(
			"n",
			{ action: "add", path: ".env", name: "PORT", value: 8080 },
			undefined,
			undefined,
			ctx,
		);
		expect(write.isError).not.toBe(true);
		expect(readFileSync(join(cwd, ".env"), "utf8")).toContain('PORT="8080"');
		const read = await tool.execute(
			"n",
			{ action: "read", path: ".env", names: ["PORT"] },
			undefined,
			undefined,
			ctx,
		);
		expect(read.content[0].text).toBe("PORT=8080");
		const event = { toolName: "fixture", input: { value: "$TOKEN" } };
		expect(await inject(event, ctx)).toBeUndefined();
		expect(event.input.value).toBe("fixture-secret");
		const invalid = await tool.execute(
			"n",
			{ action: "add", path: "notes.txt", name: "PORT", value: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(invalid.isError).toBe(true);
	} finally {
		process.chdir(previousCwd);
		rmSync(cwd, { recursive: true, force: true });
	}
});
