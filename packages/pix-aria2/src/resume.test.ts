import { expect, mock, test } from "bun:test";
import { collapseDelayMs } from "@xynogen/pix-runtime/collapse";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

test("W1 capture: resume restarts progress polling after paused downloads clear it", async () => {
	const fixture = await withUiFixture();
	let active: unknown[] = [];
	let intervalStarts = 0;
	let tick: (() => void) | undefined;
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const originalDateNow = Date.now;
	let now = 1_000;
	let signalWidget: (() => void) | undefined;
	const poll = () =>
		new Promise<void>((resolve) => {
			signalWidget = resolve;
			if (!tick) throw new Error("poll timer was not registered");
			tick();
		});
	globalThis.setInterval = ((callback: () => void) => {
		intervalStarts++;
		tick = callback;
		return intervalStarts;
	}) as never;
	globalThis.clearInterval = (() => {}) as never;
	Date.now = () => now;

	let shutdown: (() => Promise<void>) | undefined;
	try {
		mock.module("maria2/dist/index.js", () => ({
			aria2: {
				addUri: async () => "gid-1",
				pause: async () => {},
				remove: async () => {},
				tellActive: async () => active,
				unpause: async () => {},
			},
		}));
		mock.module("./daemon.ts", () => ({
			Aria2MissingError: class Aria2MissingError extends Error {},
			startDaemon: async () => ({
				conn: {},
				port: 1,
				proc: {},
				secret: "fixture",
				shutdown: async () => {},
			}),
		}));
		let nextHandle = 42;
		mock.module("@xynogen/pix-runtime/lfid", () => ({
			generateLfid: () => `dl-fixed-otter-${nextHandle++}`,
		}));
		const { default: registerDownload } = await import("./index.ts");
		let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
		registerDownload({
			on(name: string, handler: () => Promise<void>) {
				if (name === "session_shutdown") shutdown = handler;
			},
			registerTool(value: { execute: (...args: unknown[]) => Promise<unknown> }) {
				tool = value;
			},
		} as never);
		if (!tool) throw new Error("download tool was not registered");
		const registeredTool = tool;
		let widget: unknown;
		const run = (params: object) =>
			registeredTool.execute("call", params, new AbortController().signal, undefined, {
				cwd: fixture.agentDir,
				ui: {
					setWidget(_key: string, value: unknown) {
						widget = value;
						signalWidget?.();
					},
				},
			});

		const added = (await run({ action: "add", url: "https://example.com/file.iso" })) as {
			content: Array<{ type: string; text: string }>;
		};
		const handle = added.content[0]?.text.match(/dl-[\w-]+/)?.[0];
		if (!handle) throw new Error("add did not return a download handle");
		expect(intervalStarts).toBe(1);

		active = [
			{
				gid: "gid-1",
				status: "active",
				totalLength: "100",
				completedLength: "50",
				downloadSpeed: "10",
				files: [{ path: "/tmp/file.iso", uris: [] }],
			},
		];
		await poll();
		if (typeof widget !== "function") throw new Error("progress widget was not registered");
		const component = widget({}, { fg: (_key: string, text: string) => text });
		const rendered = component.render(20) as string[];
		expect(rendered[0]).toBe("─".repeat(20));
		expect(rendered[2]).toMatch(/^ {2}\S+ dl-[\w-]+/);
		expect(
			captureRows(widget({}, roleTheme()), { width: 80, surface: "component" }),
		).toMatchSnapshot("single active widget");
		active.push({
			gid: "gid-2",
			status: "active",
			totalLength: "1000",
			completedLength: "250",
			downloadSpeed: "100",
			files: [{ path: "/fixture/a-long-download-name-for-width-sensitive-progress.iso" }],
		});
		await poll();
		const progress = widget({}, roleTheme());
		expect(captureRows(progress, { width: 80, surface: "component" })).toMatchSnapshot(
			"active widget",
		);
		expect(captureRows(progress, { width: 120, surface: "component" })).toMatchSnapshot(
			"wide widget",
		);

		active = [
			{
				gid: "gid-1",
				status: "active",
				totalLength: "100",
				completedLength: "100",
				downloadSpeed: "0",
				files: [{ path: "/tmp/file.iso", uris: [] }],
			},
		];
		await poll();
		expect(widget).toBeDefined();
		expect(
			captureRows(widget({}, roleTheme()), { width: 80, surface: "component" }),
		).toMatchSnapshot("retained completion");
		now += collapseDelayMs() + 1;
		await poll();
		expect(widget).toBeUndefined();

		active = [];
		await poll();
		await run({ action: "resume", handle });
		expect(intervalStarts).toBe(2);
	} finally {
		try {
			await shutdown?.();
		} finally {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
			Date.now = originalDateNow;
			mock.restore();
			await fixture.restore();
		}
	}
});
