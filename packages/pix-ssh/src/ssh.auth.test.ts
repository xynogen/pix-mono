import { expect, mock, test } from "bun:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OverlayUI } from "@xynogen/pix-pretty/gate-overlay";
import { capturePi } from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { setUnattendedMode } from "@xynogen/pix-runtime";
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
let hostKeyError = "";
const resets = mock(async () => {
	hostKeyError = "";
});
const probes: string[] = [];
const closed = mock(async () => {});
const runs: RunOptions[] = [];
const fileRuns: Array<{
	action: string;
	input: { path: string };
	opts: Pick<RunOptions, "controlPath" | "loginPassword" | "signal">;
}> = [];
mock.module("./lib.ts", () => ({
	...actual,
	controlPathFor: () => "/fixture/none.sock",
	resolveSshHost: async (spec: HostSpec) => spec,
	probeKeyAuth: async (_spec: HostSpec, controlPath: string) => {
		probes.push(controlPath);
		if (hostKeyError) throw new actual.HostKeyError(hostKeyError);
		return keyWorks ? "ok" : "auth";
	},
	probeSftp: async (_spec: HostSpec, controlPath: string) => {
		probes.push(controlPath);
		if (hostKeyError) throw new actual.HostKeyError(hostKeyError);
		return keyWorks ? "ok" : "auth";
	},
	runFile: async (
		_spec: HostSpec,
		action: string,
		input: { path: string },
		opts: Pick<RunOptions, "controlPath" | "loginPassword" | "signal">,
	) => {
		fileRuns.push({ action, input, opts });
		return { stdout: "1#ABC|hello", stderr: "", code: 0 };
	},
	probePasswordAuth: async () => true,
	probeSudoNoPassword: async () => false,
	closeMaster: closed,
	resetKnownHost: resets,
	runTransfer: async () => ({ stdout: "copied", stderr: "", code: 0 }),
	runSsh: async (_spec: HostSpec, _command: string, opts: RunOptions) => {
		runs.push(opts);
		return { stdout: "ok", stderr: "", code: 0 };
	},
}));
const { default: register } = await import("./index.ts");

// Overlay stand-in: approve, and type a password when the stage asks for one.
let allowSession = false;
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
	if (allowSession) component.handleInput("\x1b[B");
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

test("session approval reuse and YOLO skip blocked state; real prompts still block", async () => {
	keyWorks = true;
	const { pi, tool } = capturePi();
	const events = createEventBus();
	const states: string[] = [];
	events.on("pix:agent-state", (raw) => states.push((raw as { state: string }).state));
	register({ ...pi, events } as unknown as ExtensionAPI);
	const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
	const overlay = mock(custom);
	const notify = mock(() => {});
	const ctx = { hasUI: true, ui: { custom: overlay, notify } };
	const call = (command = "id") =>
		execute(
			"session",
			{ action: "command", host: "u@session-host", command, reason: "r" },
			undefined,
			undefined,
			ctx,
		);

	allowSession = true;
	try {
		expect((await call()).details).toMatchObject({ outcome: "success" });
	} finally {
		allowSession = false;
	}
	expect(states).toEqual(["blocked", "idle"]);
	expect(overlay).toHaveBeenCalledTimes(1);

	states.length = 0;
	expect((await call()).details).toMatchObject({ outcome: "success" });
	expect(states).toEqual([]);
	expect(overlay).toHaveBeenCalledTimes(1);
	expect(notify).toHaveBeenLastCalledWith(
		"ssh_run: reused session approval for u@session-host",
		"info",
	);

	expect((await call("sudo id")).details).toMatchObject({ outcome: "success" });
	expect(states).toEqual(["blocked", "idle"]);
	expect(overlay).toHaveBeenCalledTimes(2);

	states.length = 0;
	setUnattendedMode(events, "yolo");
	expect((await call("sudo id")).details).toMatchObject({ outcome: "success" });
	expect(states).toEqual([]);
	expect(overlay).toHaveBeenCalledTimes(2);
});

test("unattended transfers stay unblocked; a missing login password still prompts", async () => {
	const { pi, tool } = capturePi();
	const events = createEventBus();
	const states: string[] = [];
	events.on("pix:agent-state", (raw) => states.push((raw as { state: string }).state));
	register({ ...pi, events } as unknown as ExtensionAPI);
	const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
	const overlay = mock(custom);
	const ctx = { hasUI: true, ui: { custom: overlay, notify() {} } };
	keyWorks = true;
	for (const mode of ["afk", "yolo"] as const) {
		setUnattendedMode(events, mode);
		const result = await execute(
			"transfer",
			{ action: "upload", host: "transfer-host", source: "a", destination: "b" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details).toMatchObject({ outcome: "success" });
		expect(states).toEqual([]);
		expect(overlay).toHaveBeenCalledTimes(0);
	}

	keyWorks = false;
	const result = await execute(
		"password",
		{ action: "command", host: "missing-password-host", command: "id" },
		undefined,
		undefined,
		ctx,
	);
	expect(result.details).toMatchObject({ outcome: "success", auth: "password" });
	expect(states).toEqual(["blocked", "idle"]);
	expect(overlay).toHaveBeenCalledTimes(1);
});

test("nuclear skips command and transfer approval but still prompts for missing authentication", async () => {
	const { pi, tool } = capturePi();
	const events = createEventBus();
	register({ ...pi, events } as unknown as ExtensionAPI);
	setUnattendedMode(events, "nuclear");
	const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
	const overlay = mock(custom);
	const ctx = { hasUI: true, ui: { custom: overlay, notify() {} } };
	keyWorks = true;
	for (const params of [
		{ action: "command", host: "nuclear-command", command: "sudo id", sudo: true },
		{
			action: "upload",
			host: "nuclear-transfer",
			source: "a",
			destination: "b",
		},
	]) {
		const result = await execute("n", params, undefined, undefined, ctx);
		expect(result.details).toMatchObject({ outcome: "success" });
	}
	// sudo needs its own password, even when login uses a key.
	expect(overlay).toHaveBeenCalledTimes(1);
	keyWorks = false;
	const result = await execute(
		"n",
		{ action: "command", host: "nuclear-password", command: "id" },
		undefined,
		undefined,
		ctx,
	);
	expect(result.details).toMatchObject({ outcome: "success", auth: "password" });
	expect(overlay).toHaveBeenCalledTimes(2);
});

test("host key mismatch: red menu defaults to Cancel even in YOLO; reset reconnects only after explicit approval", async () => {
	const { pi, tool } = capturePi();
	const events = createEventBus();
	register({ ...pi, events } as unknown as ExtensionAPI);
	setUnattendedMode(events, "yolo");
	const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
	const fingerprint = "SHA256:Im8VhrtZRdV5Pbljb3+EtjaQsAPIBbktRrRk5wYKmVk";
	hostKeyError = `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nThe fingerprint for the ED25519 key sent by the remote host is\n${fingerprint}.\n  remove with:\n  ssh-keygen -f '/fixture/known_hosts' -R '10.10.36.202'\nHost key verification failed.`;
	let acceptReset = false;
	const screens: string[] = [];
	const overlay: OverlayUI["custom"] = async (factory) => {
		let finish!: (value: unknown) => void;
		const done = new Promise<unknown>((resolve) => {
			finish = resolve;
		});
		const component = factory(
			{ requestRender() {}, terminal: { rows: 80 } },
			roleTheme(),
			undefined,
			finish,
		);
		const rows = component.render(140).join("\n");
		screens.push(rows);
		expect(rows).toContain(
			roleTheme().fg("error", roleTheme().bold("⚠ SSH HOST KEY CHANGED — verify before resetting")),
		);
		expect(rows).toContain(fingerprint);
		expect(rows).not.toContain("SSH login password:");
		if (acceptReset) component.handleInput("\x1b[B");
		component.handleInput("\r");
		return (await done) as never;
	};
	const ctx = { hasUI: true, ui: { custom: overlay, notify() {} } };
	const call = () =>
		execute(
			"host-key",
			{ action: "command", host: "xynogen@10.10.36.202", command: "id", reason: "check" },
			undefined,
			undefined,
			ctx,
		);
	const before = runs.length;
	try {
		const cancelled = await call();
		expect(cancelled.details).toMatchObject({ outcome: "error", errorKind: "host-key" });
		expect((cancelled.content[0] as { text: string }).text).toContain(hostKeyError);
		expect(resets).not.toHaveBeenCalled();
		expect(runs).toHaveLength(before);
		acceptReset = true;
		keyWorks = true;
		expect((await call()).details).toMatchObject({
			outcome: "success",
			auth: "key",
			connection: "new",
		});
		expect(resets).toHaveBeenCalledTimes(1);
		expect(runs).toHaveLength(before + 1);
		expect(screens).toHaveLength(2);
	} finally {
		hostKeyError = "";
	}
});

test("SFTP actions validate before auth, retain approval, and use the file backend", async () => {
	keyWorks = true;
	const { pi, tool } = capturePi();
	const events = createEventBus();
	register({ ...pi, events } as unknown as ExtensionAPI);
	const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
	const overlay = mock(custom);
	const ctx = { hasUI: true, ui: { custom: overlay, notify() {} } };
	const call = (params: Record<string, unknown>) =>
		execute("files", { host: "u@sftp-host", reason: "file", ...params }, undefined, undefined, ctx);
	const beforeProbes = probes.length;
	for (const params of [
		{ action: "write", path: "/a" },
		{ action: "read", path: "bad\n!command" },
		{ action: "edit", path: "/a", edits: [] },
		{ action: "read", path: "/a", offset: 0 },
		{ action: "write", path: "/a", content: "x", sudo: true },
	]) {
		expect((await call(params)).isError).toBe(true);
	}
	expect(probes.length).toBe(beforeProbes);
	expect(overlay).not.toHaveBeenCalled();
	for (const params of [
		{ action: "read", path: "C:\\app\\a" },
		{ action: "write", path: "/a", content: "" },
		{ action: "edit", path: "/a", edits: [{ oldText: "a", newText: "b" }] },
	]) {
		expect((await call(params)).details).toMatchObject({ outcome: "success" });
	}
	expect(fileRuns.slice(-3).map((r) => r.action)).toEqual(["read", "write", "edit"]);
	expect(fileRuns.at(-3)?.input.path).toBe("/C:/app/a");
	expect(overlay).toHaveBeenCalledTimes(3);
	setUnattendedMode(events, "afk");
	const before = fileRuns.length;
	expect((await call({ action: "write", path: "/a", content: "x" })).details).toMatchObject({
		outcome: "denied",
	});
	expect(fileRuns.length).toBe(before);
});
