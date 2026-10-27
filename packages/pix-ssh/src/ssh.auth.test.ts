import { expect, mock, test } from "bun:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OverlayUI } from "@xynogen/pix-pretty/gate-overlay";
import { capturePi } from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { roleTheme } from "../../../scripts/ui-capture.ts";

import type { HostSpec, RunOptions } from "./lib.ts";

// Regression: a cached login password made ssh_run skip the key probe and reuse
// the password-authed master, so "did key login work?" could never be answered.
const actual = await import("./lib.ts");
const binaries = await import("@xynogen/pix-runtime/binaries");
mock.module("@xynogen/pix-runtime/binaries", () => ({
	...binaries,
	requireTool: () => "/fixture/ssh",
}));
let keyWorks = false;
const probes: string[] = [];
const closed = mock(async () => {});
const runs: RunOptions[] = [];
mock.module("./lib.ts", () => ({
	...actual,
	controlPathFor: () => "/fixture/none.sock",
	resolveSshHost: async (spec: HostSpec) => spec,
	probeKeyAuth: async (_spec: HostSpec, controlPath: string) => {
		probes.push(controlPath);
		return keyWorks ? "ok" : "auth";
	},
	probePasswordAuth: async () => true,
	probeSudoNoPassword: async () => false,
	closeMaster: closed,
	runSsh: async (_spec: HostSpec, _command: string, opts: RunOptions) => {
		runs.push(opts);
		return { stdout: "ok", stderr: "", code: 0 };
	},
}));
const { default: register } = await import("./index.ts");

// Overlay stand-in: approve, and type a password when the stage asks for one.
const custom: OverlayUI["custom"] = async (factory) => {
	let finish!: (value: unknown) => void;
	const done = new Promise<unknown>((resolve) => {
		finish = resolve;
	});
	const component = factory(
		{ requestRender() {}, terminal: { rows: 24 } },
		roleTheme(),
		undefined,
		finish,
	);
	component.handleInput("\r");
	component.handleInput("pw");
	component.handleInput("\r");
	return (await done) as never;
};

test("cached password: key is re-checked, then the call reports key auth", async () => {
	const { pi, tool } = capturePi();
	register({ ...pi, events: createEventBus() } as unknown as ExtensionAPI);
	const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
	const ctx = { hasUI: true, ui: { custom, notify() {} } };
	const call = (fresh = false) =>
		execute(
			"t",
			{ action: "command", host: "u@h", command: "id", reason: "r", fresh },
			undefined,
			undefined,
			ctx,
		);

	// 1. No key yet: password login, reported as such.
	const first = await call();
	expect(first.details).toMatchObject({ outcome: "success", auth: "password" });
	expect(runs.at(-1)?.loginPassword).toBe("pw");

	// 2. Key installed. A fresh call must probe with multiplexing off (bypassing
	//    the password-authed master), drop the cached password, and use the key.
	keyWorks = true;
	probes.length = 0;
	const second = await call(true);
	expect(probes[0]).toBe("none");
	expect(closed).toHaveBeenCalled();
	expect(runs.at(-1)?.loginPassword).toBeUndefined();
	expect(second.details).toMatchObject({ outcome: "success", auth: "key" });
	expect((second.content[0] as { text: string }).text).toMatch(
		/^Exit code: 0 \(auth: key, (new|reused) connection\)/,
	);
});
