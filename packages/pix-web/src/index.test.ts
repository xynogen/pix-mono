import { expect, test } from "bun:test";
import registerWeb from "./index.ts";

test("standalone web registers its command without registering shared /pix", () => {
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
	expect(commands).toEqual(["web"]);
	expect(events).toContain("session_start");
});
