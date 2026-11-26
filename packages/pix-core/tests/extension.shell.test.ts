import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { pixRuntime } from "@xynogen/pix-runtime/config";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { extensionsSection } from "@xynogen/pix-runtime/sections";
import { withUiFixture } from "../../../scripts/ui-capture.ts";
import registerPlanMode from "../src/plan-mode.ts";

// ponytail: core has no renderer. Stub member factories to prove ordering without settings patches or sessions.
test("core awaits member factories in order and skips a failing member", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	const members = [
		"@xynogen/pix-runtime",
		"@xynogen/pix-data",
		"@xynogen/pix-pretty",
		"@xynogen/pix-welcome/extension",
		"@xynogen/pix-footer/extension",
		"@xynogen/pix-models/extension",
		"@xynogen/pix-update/extension",
		"@xynogen/pix-commands/extension",
		"@xynogen/pix-nudge/extension",
		"@xynogen/pix-diagnostics/extension",
		"@xynogen/pix-display",
		"@xynogen/pix-prompts/extension",
		"@xynogen/pix-skills",
		"@xynogen/pix-read/extension",
		"@xynogen/pix-write/extension",
		"@xynogen/pix-edit/extension",
		"@xynogen/pix-find/extension",
		"@xynogen/pix-grep/extension",
		"@xynogen/pix-ls/extension",
		"@xynogen/pix-bash/extension",
		"@xynogen/pix-powershell/extension",
		"@xynogen/pix-todo",
		"@xynogen/pix-ask",
		"@xynogen/pix-optimizer",
		"@xynogen/pix-gate",
		"@xynogen/pix-notify",
		"@xynogen/pix-subagent/extension",
	];
	const originals = new Map<string, Record<string, unknown>>();
	const release = Promise.withResolvers<void>();
	let pending: Promise<void> | undefined;
	try {
		for (const path of members) originals.set(path, { ...(await import(path)) });
		const entered = Promise.withResolvers<void>();
		const seen: string[] = [];
		let fail = false;
		for (const path of members)
			mock.module(path, () => ({
				...originals.get(path),
				default: async () => {
					seen.push(path);
					if (path === members[0]) {
						entered.resolve();
						await release.promise;
						if (fail) throw new Error("fixture registration failed");
					}
				},
			}));
		const { default: extension } = await import("../src/extension.ts");
		const events: string[] = [];
		const commands: string[] = [];
		const registered: Array<{ name: string; exposure?: string }> = [];
		const pi = {
			events: new EventEmitter(),
			on: (event: string) => events.push(event),
			registerTool: (tool: { name: string; exposure?: string }) => registered.push(tool),
			registerCommand: (name: string) => commands.push(name),
			registerShortcut() {},
		};
		pending = extension(pi as never);
		await entered.promise;
		const query = { version: "" };
		pi.events.emit("pix:core-version", query);
		const { version } = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		);
		expect(query.version).toBe(version);
		expect(seen).toEqual([members[0]!]);
		expect(events).toEqual(["session_start", "tool_call", "tool_result"]); // Deferred-tool wrapper precedes runtime.
		release.resolve();
		await pending;
		expect(seen).toEqual(members);
		expect(events).toEqual([
			"session_start",
			"tool_call",
			"tool_result",
			"session_before_compact",
			"agent_before_settle",
			"agent_settled",
			"session_start",
			"tool_call",
			"session_start",
		]);
		// pix-runtime is stubbed, so the Extensions panel is the one that claims /pix.
		expect(commands).toEqual(["plan", "pix"]);
		pi.registerTool({ name: "read" });
		pi.registerTool({ name: "fixture-feature" });
		expect(registered).toEqual([
			{ name: "read" },
			{ name: "fixture-feature", exposure: "deferred" },
		]);
		seen.length = 0;
		fail = true;
		const starts: Array<(event: unknown, ctx: unknown) => void> = [];
		await extension({
			...pi,
			on: (event: string, h: (typeof starts)[0]) => event === "session_start" && starts.push(h),
		} as never);
		// A failing member is skipped; the rest still load and one warning is shown on session_start.
		expect(seen).toEqual(members);
		const notices: Array<[string, string]> = [];
		// The warning handler registers after every member, so it is the last session_start.
		starts.at(-1)?.({}, { ui: { notify: (m: string, l: string) => notices.push([m, l]) } });
		const warning = notices.find(([, level]) => level === "warning");
		expect(warning?.[0]).toMatch(
			/^pix-core skipped 1 member\(s\):\n@xynogen\/pix-runtime: fixture registration failed\n/,
		);
		// The real source must still list each declared member. No independent core rendering exists.
		const source = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
		for (const member of members) expect(source).toContain(`"${member}"`);
		// A member listed in pix.json extensions.disabled is never imported or run.
		const runtime = pixRuntime();
		await runtime.update(extensionsSection, {
			disabled: ["@xynogen/pix-footer", "@xynogen/pix-gate"],
		});
		try {
			seen.length = 0;
			fail = false;
			await extension({ ...pi, on() {} } as never);
			expect(seen).toEqual(members.filter((m) => m !== "@xynogen/pix-footer/extension"));
		} finally {
			await runtime.update(extensionsSection, { disabled: [] });
		}
	} finally {
		release.resolve();
		try {
			await pending;
		} finally {
			for (const [path, original] of originals) mock.module(path, () => original);
			await fixture.restore();
		}
	}
});

test("restored plan mode keeps tools available and guards edit/write paths", async () => {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	let active = ["read", "grep", "bash"];
	let toggle!: (ctx: unknown) => void;
	registerPlanMode({
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand() {},
		registerShortcut: (_key: string, options: { handler: typeof toggle }) => {
			toggle = options.handler;
		},
		getActiveTools: () => active,
		setActiveTools: (tools: string[]) => {
			active = tools;
		},
		appendEntry() {},
	} as never);
	const ctx = {
		mode: "rpc",
		cwd: tempDir(),
		sessionManager: {
			getEntries: () => [
				{
					type: "custom",
					customType: "pix-plan-mode",
					data: { enabled: true },
				},
			],
		},
		ui: { setStatus() {}, theme: { fg: (_role: string, value: string) => value }, notify() {} },
	};
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	expect(active).toEqual(["read", "grep", "bash"]);
	const guard = handlers.get("tool_call")?.[0];
	if (!guard) throw new Error("Plan tool guard is missing");
	for (const toolName of ["speak", "agent", "codemode", "tool_search"])
		expect(await guard({ toolName, input: {} }, ctx)).toBeUndefined();
	for (const toolName of ["edit", "write"]) {
		for (const path of ["src/index.ts", ".pi/plans/../outside.md"])
			expect(await guard({ toolName, input: { path } }, ctx)).toMatchObject({ block: true });
		expect(await guard({ toolName, input: { path: ".pi/plans/auth.md" } }, ctx)).toBeUndefined();
	}
	expect(await guard({ toolName: "read", input: { path: "src/index.ts" } }, ctx)).toBeUndefined();
	toggle(ctx);
	expect(active).toEqual(["read", "grep", "bash"]);
	expect(await guard({ toolName: "edit", input: {} }, ctx)).toBeUndefined();
});
