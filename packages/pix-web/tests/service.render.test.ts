import { expect, test } from "bun:test";
import { promises as dns } from "node:dns";
import { makeRenderCtx } from "@xynogen/pix-pretty/test-utils";
import type { PackageSettings } from "@xynogen/pix-runtime";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

// Snapshot budget exception: 208 lines retain both web actions, the 32/33-line preview boundary, and four actual command states.
test("captures web fetch and search Markdown without links or external execution", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	try {
		const { webTool } = await import("../src/web-tool.ts");
		const tool = webTool();
		expect([tool.name, tool.renderShell]).toEqual(["web", "self"]);
		const theme = roleTheme();
		const output: string[] = [];
		const rows = (label: string, component: { render(width: number): string[] } | undefined) => {
			if (!component) throw new Error("Missing web renderer");
			const rendered = captureRows(component, { width: 80, surface: "host-self" });
			output.push(label, ...rendered);
			return rendered;
		};
		// Renderers route by the call's action, so every context carries the call args.
		const ctx = (args: object, overrides: Parameters<typeof makeRenderCtx>[0] = {}) =>
			({ ...makeRenderCtx(overrides), args }) as never;
		// ponytail: link-free fixtures retain actual Markdown. OSC 8 hyperlinks remain a harness blocker.
		for (const action of ["fetch", "search"] as const) {
			const args =
				action === "fetch"
					? { action, url: "https://example.test/guide" }
					: { action, query: "code guide" };
			const result = {
				content: [{ type: "text" as const, text: "# Guide\n\n- **Read** the code.\n- *Test* it." }],
				details: {
					target: action === "fetch" ? "https://example.test/guide" : "code guide",
					meta: "2 items · fixture",
					outcome: "success",
				},
			};
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: false,
				tools: {},
			}));
			rows(`${action}:call`, tool.renderCall?.(args, theme as never, ctx(args)));
			const completed = rows(
				`${action}:markdown`,
				tool.renderResult?.(
					result,
					{ expanded: false, isPartial: false },
					theme as never,
					ctx(args),
				),
			);
			expect(completed.at(-1)).toBe(`<success>${"─".repeat(80)}</success>`);
			rows(
				`${action}:partial`,
				tool.renderResult?.(
					{ ...result, content: [{ type: "text", text: "Loading..." }] },
					{ expanded: false, isPartial: true },
					theme as never,
					ctx(args),
				),
			);
			const error = rows(
				`${action}:error`,
				tool.renderResult?.(
					{
						...result,
						content: [{ type: "text", text: "offline" }],
						details: { ...result.details, outcome: "error" },
					},
					{ expanded: false, isPartial: false },
					theme as never,
					ctx(args),
				),
			);
			expect(error.at(-1)).toBe(`<error>${"─".repeat(80)}</error>`);
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: true,
				tools: {},
			}));
			for (const outcome of ["success", "error", "cancelled"]) {
				rows(
					`${action}:collapsed-${outcome}`,
					tool.renderResult?.(
						{ ...result, details: { ...result.details, outcome } },
						{ expanded: false, isPartial: false },
						theme as never,
						ctx(args, { state: { collapsed: true } }),
					),
				);
			}
			rows(
				`${action}:hidden-call`,
				tool.renderCall?.(args, theme as never, ctx(args, { state: { collapsed: true } })),
			);
			rows(
				`${action}:expanded`,
				tool.renderResult?.(
					result,
					{ expanded: true, isPartial: false },
					theme as never,
					ctx(args, { expanded: true, state: { collapsed: true } }),
				),
			);
		}
		const fetchArgs = { action: "fetch", url: "https://example.test/guide" };
		const longText = Array.from({ length: 33 }, (_, index) => `row ${index + 1}`).join("\n");
		for (const expanded of [false, true])
			rows(
				`fetch:${expanded ? "full" : "preview32"}`,
				tool.renderResult?.(
					{ content: [{ type: "text", text: longText }], details: undefined },
					{ expanded, isPartial: false },
					theme as never,
					ctx(fetchArgs, { expanded }),
				),
			);
		for (const [label, text, isError] of [
			["empty", "", false],
			["host-error", "host failed", true],
		] as const)
			rows(
				`fetch:${label}`,
				tool.renderResult?.(
					{ content: [{ type: "text", text }], details: undefined },
					{ expanded: false, isPartial: false },
					theme as never,
					ctx(fetchArgs, { isError }),
				),
			);
		expect(output.join("\n")).toMatchSnapshot();
	} finally {
		await fixture.restore();
	}
});

test("captures actual web command rows with fixed provider maps and no saves", async () => {
	const fixture = await withUiFixture();
	const globals = globalThis as unknown as Record<symbol, unknown>;
	const keys = [
		Symbol.for("@xynogen/pix-web/providers"),
		Symbol.for("@xynogen/pix-web/search-providers"),
	];
	const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
	const fetcher = globalThis.fetch;
	const lookup = dns.lookup;
	let restoreConfigs = () => {};
	try {
		globalThis.fetch = (() => {
			throw new Error("Capture must not fetch");
		}) as unknown as typeof fetch;
		dns.lookup = (() => {
			throw new Error("Capture must not resolve DNS");
		}) as typeof dns.lookup;
		for (const key of keys) globals[key] = new Map();
		const { fetchConfig } = await import("../src/config.ts");
		const { searchConfig } = await import("../src/search-config.ts");
		const configs = [fetchConfig, searchConfig];
		const saved = configs.map((config) => ({ ...config }));
		restoreConfigs = () => {
			configs.forEach((config, index) => {
				Object.assign(config, saved[index]);
			});
		};
		const { registerWebCommand } = await import("../src/command.ts");
		let open!: PackageSettings["open"];
		registerWebCommand({
			registerCommand: (name: string) => {
				expect(name).toBe("pix");
			},
			events: {
				emit() {},
				on(channel: string, listener: (data: unknown) => void) {
					if (channel !== "pix:settings") return;
					const entries = new Map<string, PackageSettings>();
					listener(entries);
					expect(entries.get("pix-web")?.label).toBe("Web");
					open = entries.get("pix-web")!.open;
				},
			},
		} as never);
		const output: string[] = [];
		for (const state of ["auto", "unknown", "missing", "connected"] as const) {
			configs.forEach((config, index) => {
				Object.assign(config, {
					provider: state === "auto" ? "auto" : state === "unknown" ? "absent" : "9router",
					nineRouterModel: index === 0 ? "selected-fetch" : "selected-search",
				});
			});
			for (const key of keys)
				(globals[key] as Map<string, unknown>).set("9router", {
					id: "9router",
					env: ["FIXTURE_API_KEY"],
					isConfigured: () => state === "connected",
				});
			await open({
				ui: {
					custom: async (
						factory: (
							tui: unknown,
							theme: unknown,
							kb: unknown,
							done: unknown,
						) => { render(width: number): string[]; dispose?(): void },
					) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 40 } },
							roleTheme(),
							{ matches: () => false },
							() => {},
						);
						try {
							output.push(
								`web:${state}`,
								...captureRows(component, { width: 80, surface: "component" }),
							);
						} finally {
							component.dispose?.();
						}
						return null;
					},
				},
			} as never);
		}
		expect(output.join("\n")).toMatchSnapshot();
	} finally {
		restoreConfigs();
		globalThis.fetch = fetcher;
		dns.lookup = lookup;
		keys.forEach((key, index) => {
			const descriptor = previous[index];
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		});
		await fixture.restore();
	}
});
