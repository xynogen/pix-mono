import { expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { makeRenderCtx } from "@xynogen/pix-pretty/test-utils";
import { collapseSection, gateSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

// Snapshot budget exception: 174 lines retain six modes and seven real picker states, including ten visible scroll rows.
test("captures registered skill Text output and complete expanded instructions", async () => {
	const fixture = await withUiFixture();
	const agent = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
		await fixture.runtime.update(gateSection, {
			guardrails: "on",
			autoApprove: [],
			extraRules: [],
		});
		const { default: register } = await import("./index.ts");
		let tool: ToolDefinition | undefined;
		register({
			registerTool: (definition: ToolDefinition) => {
				tool = definition;
			},
			on() {},
		} as never);
		if (!tool) throw new Error("Missing read_skills renderer");
		expect([tool.name, tool.renderShell]).toEqual(["read_skills", "self"]);
		const theme = roleTheme();
		const output: string[] = [];
		const rows = (label: string, component: { render(width: number): string[] } | undefined) => {
			if (!component) throw new Error("Missing skill component");
			const rendered = captureRows(component, { width: 80, surface: "host-self" });
			output.push(label, ...rendered);
			return rendered;
		};
		const results = [
			{ name: "test", source: "acme/skills", slug: "acme/skills/test", installs: 1200 },
			{ name: "lint", source: "acme/tools", slug: "acme/tools/lint", installs: 3000 },
		];
		const cases = [
			{ args: {}, text: "Available skills (2): lint · test", details: { mode: "list", count: 2 } },
			{
				args: { name: "test" },
				text: "test: Test the code.",
				details: { mode: "description", name: "test" },
			},
			{
				args: { name: "test", full: true },
				text: "x".repeat(101),
				details: { mode: "instructions", name: "test", lines: 1 },
			},
			{
				args: { name: "test", resource: "references/rules.md" },
				text: "# Rules\nKeep raw bytes.",
				details: { mode: "reference", name: "test", resource: "references/rules.md", bytes: 22 },
			},
			{
				args: { name: "test", resource: "scripts/test.ts", output: ".pi/tools/test.ts" },
				text: "Copied.",
				details: {
					mode: "copy",
					name: "test",
					resource: "scripts/test.ts",
					output: ".pi/tools/test.ts",
					bytes: 2048,
				},
			},
			{
				args: { search: "code" },
				text: "search results",
				details: { mode: "search", query: "code", count: 2, results },
			},
		];
		for (const item of cases) {
			const result = {
				content: [{ type: "text" as const, text: item.text }],
				details: item.details,
			};
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: false,
				tools: {},
			}));
			rows(
				`${item.details.mode}:call`,
				tool.renderCall?.(item.args, theme as never, makeRenderCtx() as never),
			);
			const rendered = rows(
				item.details.mode,
				tool.renderResult?.(
					result,
					{ expanded: true, isPartial: false },
					theme as never,
					makeRenderCtx({ expanded: true }) as never,
				),
			);
			expect(rendered.at(-1)).toBe(`<success>${"- ".repeat(40)}</success>`);
			if (item.details.mode === "instructions")
				expect(
					rendered
						.slice(2, -1)
						.map((row) => row.match(/<muted>(.*?)<\/muted>/)?.[1] ?? "")
						.join(""),
				).toBe(`${"x".repeat(101)}`);
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: true,
				tools: {},
			}));
			rows(
				`${item.details.mode}:collapsed`,
				tool.renderResult?.(
					result,
					{ expanded: false, isPartial: false },
					theme as never,
					makeRenderCtx({ state: { collapsed: true } }) as never,
				),
			);
		}
		rows(
			"hidden-call",
			tool.renderCall?.({}, theme as never, makeRenderCtx({ state: { collapsed: true } }) as never),
		);
		const error = {
			content: [{ type: "text" as const, text: "Skill not found" }],
			details: undefined,
		};
		for (const [label, isPartial, isError] of [
			["error", false, true],
			["partial", true, false],
			["no-details", false, false],
		] as const) {
			const rendered = rows(
				label,
				tool.renderResult?.(
					error,
					{ expanded: true, isPartial },
					theme as never,
					makeRenderCtx({ expanded: true, isError }) as never,
				),
			);
			if (isError) expect(rendered.at(-1)).toBe(`<error>${"- ".repeat(40)}</error>`);
		}
		const collapsedError = tool.renderResult!(
			error,
			{ expanded: false, isPartial: false },
			theme as never,
			makeRenderCtx({ state: { collapsed: true }, isError: true }) as never,
		).render(80);
		expect(collapsedError).toHaveLength(1);
		expect(collapsedError[0]).toContain("Skill not found");
		expect(
			captureRows({ render: () => collapsedError }, { width: 80, surface: "component" })[0],
		).toContain("<error>");
		expect(output.join("\n")).toMatchSnapshot();
	} finally {
		if (agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = agent;
		await fixture.restore();
	}
});

test("captures the real skill picker with observed search completion and disposal", async () => {
	const fixture = await withUiFixture();
	const pickers: import("./picker.ts").SkillPicker[] = [];
	try {
		const { SkillPicker } = await import("./picker.ts");
		const output: string[] = [];
		const rows = (label: string, picker: InstanceType<typeof SkillPicker>) =>
			output.push(label, ...captureRows(picker, { width: 48, surface: "component" }));
		const local = [
			{ name: "test", detail: "Test the code." },
			{ name: "lint", detail: "Check format." },
		];
		const picker = new SkillPicker({
			local,
			theme: roleTheme(),
			search: async () => {
				throw new Error("Unexpected picker search");
			},
			done() {},
			onChange() {},
		});
		pickers.push(picker);
		rows("picker:local", picker);
		picker.handleInput("e");
		rows("picker:filtered", picker);
		for (const mode of ["remote", "empty", "failure"] as const) {
			let complete!: () => void;
			const completion = new Promise<void>((resolve) => {
				complete = resolve;
			});
			const current = new SkillPicker({
				local: [],
				theme: roleTheme(),
				delayMs: 0,
				search: async () => {
					if (mode === "failure") throw new Error("offline");
					return mode === "remote"
						? [{ name: "test-pro", source: "acme/skills", detail: "1.2K installs" }]
						: [];
				},
				done() {},
				onChange: complete,
			});
			pickers.push(current);
			current.handleInput("t");
			current.handleInput("d");
			if (mode === "remote") rows("picker:searching", current);
			await completion;
			rows(`picker:${mode}`, current);
		}
		const scrolling = new SkillPicker({
			local: Array.from({ length: 12 }, (_, index) => ({
				name: `skill-${index + 1}`,
				detail: "Guide",
			})),
			theme: roleTheme(),
			search: async () => [],
			done() {},
			onChange() {},
		});
		pickers.push(scrolling);
		for (let index = 0; index < 11; index++) scrolling.handleInput("\x1b[B");
		rows("picker:scroll", scrolling);
		expect(output.join("\n")).toMatchSnapshot();
	} finally {
		for (const picker of pickers) picker.dispose();
		await fixture.restore();
	}
});
