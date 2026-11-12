import { expect, test } from "bun:test";
import registerWeb from "../src/index.ts";

test("standalone web exposes settings through /pix", () => {
	const commands: string[] = [];
	const events: string[] = [];
	const pi = {
		registerCommand(name: string) {
			commands.push(name);
		},
		registerTool() {},
		on(name: string) {
			events.push(name);
		},
	} as unknown as Parameters<typeof registerWeb>[0];
	registerWeb(pi);
	expect(commands).toEqual(["pix"]);
	expect(events).toContain("session_start");
});
