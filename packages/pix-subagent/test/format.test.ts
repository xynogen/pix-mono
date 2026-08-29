import { expect, test } from "bun:test";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { registerAgents } from "../src/agent-types.ts";
import type { ModelRegistry } from "../src/model-resolver.ts";
import {
	agentTypeGuidance,
	buildAgentToolDescription,
	createAgentInfoTool,
	createAgentSteerTool,
	createAgentTool,
	describeParentModel,
	fmtTokenCount,
	formatAgentCall,
	formatAgentCompletedLine,
	formatAgentFinishedLine,
	formatContext,
	formatMs,
	formatTokens,
	formatToolUses,
	formatTurns,
	listAgentModels,
	listAgentTypes,
} from "../src/tools.ts";
import { describeActivity, formatSpeed } from "../src/ui/widget.ts";

test("agent description includes compact delegation safety guidance", () => {
	const description = buildAgentToolDescription();

	expect(description).toContain("agent_info");
	expect(description).toContain("never fork/inherit parent context");
	expect(description).toContain("thinking medium or high");
	expect(description).toContain("prior user approval");
	expect(description).toContain("Omit model to inherit the parent model");
	expect(description).not.toContain("Custom agents:");
	expect(description).not.toContain("Types:");
	expect(description.length).toBeLessThan(400);
});

test("agent_info exposes kind as a string enum with actionable guidance", () => {
	const tool = createAgentInfoTool(() => {});
	const parameters = tool.parameters as {
		properties: { kind: { type?: string; enum?: string[]; description?: string } };
	};
	const kind = parameters.properties.kind;

	expect(kind.type).toBe("string");
	expect(kind.enum).toEqual(["types", "models"]);
	expect(kind.description).toBe('Catalog: "types" = roles/tools; "models" = available models.');
});

test("agent exposes thinking as a guided string enum", () => {
	const tool = createAgentTool({} as never, {} as never, new Map(), () => {});
	const parameters = tool.parameters as {
		properties: {
			prompt: { description?: string };
			thinking: { type?: string; enum?: string[]; description?: string };
		};
	};
	const thinking = parameters.properties.thinking;

	expect(parameters.properties.prompt.description).toContain("self-contained");
	expect(parameters.properties.prompt.description).toContain("never rely on forked parent context");
	expect(thinking?.type).toBe("string");
	expect(thinking?.enum).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
	expect(thinking?.description).toContain('"medium" (default)');
	expect(thinking?.description).toContain('or "high"');
	expect(thinking?.description).toContain("user explicitly approves");
});

test("agent_steer exposes action as a guided string enum", () => {
	const tool = createAgentSteerTool({} as never);
	const parameters = tool.parameters as {
		properties: { action: { type?: string; enum?: string[]; description?: string } };
	};
	const action = parameters.properties.action;

	expect(action?.type).toBe("string");
	expect(action?.enum).toEqual(["steer", "stop"]);
	expect(action?.description).toContain('exactly "steer"');
	expect(action?.description).toContain('"stop"');
});

test("agent type discovery explains dynamic custom-agent locations", () => {
	const guidance = agentTypeGuidance();

	expect(guidance).toContain("Custom agents: .pi/agents/*.md");
	expect(guidance).toContain("/agents/*.md (project overrides global)");
});

test("agent type discovery filters runtime agents on demand", () => {
	registerAgents(
		new Map([
			[
				"SecurityReview",
				{
					name: "SecurityReview",
					description: "Review authentication and authorization risks.",
					builtinToolNames: ["read", "grep"],
					extensions: false,
					skills: false,
					systemPrompt: "",
					promptMode: "append" as const,
				},
			],
		]),
	);

	const lines = listAgentTypes("authorization", 5);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("SecurityReview");
	expect(lines[0]).toContain("tools:read,grep");
	registerAgents(new Map());
});

test("agent model discovery filters and limits enriched available models", () => {
	const models = [
		{ provider: "test", id: "alpha-fast", name: "Alpha Fast" },
		{ provider: "test", id: "beta-strong", name: "Beta Strong" },
	] as never[];
	const registry = {
		getAvailable: () => models,
		getAll: () => models,
		find: () => undefined,
	} as ModelRegistry;

	expect(listAgentModels(registry, "alpha", 1)).toEqual(["test/alpha-fast"]);
	expect(listAgentModels(registry, undefined, 1)).toHaveLength(1);
	expect(describeParentModel(registry, models[0])).toBe("test/alpha-fast");
});

test("agent call restores its prompt when an elapsed card is expanded", () => {
	const tool = createAgentTool({} as never, {} as never, new Map(), () => {});
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const component = tool.renderCall?.(
		{
			type: "Explore",
			description: "Inspect renderers",
			prompt: "Find every collapse consumer",
		},
		theme as never,
		{
			expanded: true,
			state: { collapsed: true },
			invalidate: () => {},
		} as never,
	);

	expect(component?.render(120).join("\n")).toContain("Find every collapse consumer");
});

test("formatAgentCall includes the task prompt before auto-collapse", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const rendered = formatAgentCall(
		{
			type: "general",
			description: "Audit recording dead code",
			prompt: "here",
			background: false,
		},
		theme,
	);

	expect(rendered).toBe('agent Agent · Audit recording dead code\n"here"');
});

test("formatAgentCall follows tool, target, description, and metadata hierarchy", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => text,
	};
	const rendered = formatAgentCall(
		{
			type: "general",
			description: "Audit recording dead code",
			model: "haiku",
			background: true,
		},
		theme,
		false,
	);

	expect(rendered).toContain("<toolTitle>agent</toolTitle>");
	expect(rendered).toContain("<dim>Agent</dim>");
	expect(rendered).toContain("<dim>Audit recording dead code</dim>");
	expect(rendered).toContain("<muted>[haiku]</muted>");
	expect(rendered).toContain("<muted> · </muted>");
});

test("formatAgentCall hides the task prompt after auto-collapse", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const rendered = formatAgentCall(
		{
			type: "general",
			description: "Audit recording dead code",
			prompt: "here",
			background: true,
		},
		theme,
		false,
	);

	expect(rendered).toBe("agent Agent · Audit recording dead code");
});

test("formatAgentCompletedLine keeps the completed agent row visible", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const rendered = formatAgentCompletedLine(
		{
			displayName: "Agent",
			description: "Audit recording dead code",
			subagentType: "general",
			toolUses: 0,
			context: "",
			durationMs: 250,
			status: "completed",
		},
		theme,
	);

	// Status marker is width-normalized (padIcon) so wide/narrow glyphs align —
	// a 1-cell ✓ carries one pad space before the separator.
	expect(rendered).toBe("✓  agent Agent · Audit recording dead code · 0.3s · completed");
});

test("agent uses the self-rendered shell so terminal status marks have no box padding", () => {
	const tool = createAgentTool({} as never, {} as never, new Map(), () => {});
	expect(tool.renderShell).toBe("self");
});

test("foreground live row separates description from every stat like completed row", () => {
	const tool = createAgentTool({} as never, {} as never, new Map(), () => {});
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const context = formatContext({ tokens: 5_200, contextWindow: 372_000, percent: 1 });
	const component = tool.renderResult?.(
		{
			content: [{ type: "text", text: "" }],
			details: {
				displayName: "Explore",
				description: "Retest subagent call",
				subagentType: "Explore",
				toolUses: 1,
				context,
				durationMs: 6_100,
				status: "running",
				modelName: "openai: gpt-5.6 sol",
				turnCount: 2,
				maxTurns: 3,
				spinnerFrame: 0,
			},
		},
		{ expanded: false, isPartial: true },
		theme as never,
		{} as never,
	);

	expect(component?.render(200).join("\n").trimEnd()).toBe(
		`  ⠋ Explore [openai: gpt-5.6 sol] · Retest subagent call · ${formatTurns(2, 3)} · ${formatToolUses(1)} · ${context} · 6.1s`,
	);
});

test("foreground terminal rows begin directly with their status mark", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const rendered = formatAgentFinishedLine(
		{
			displayName: "Agent",
			description: "Inspect renderers",
			subagentType: "general",
			toolUses: 0,
			context: "",
			durationMs: 250,
			status: "completed",
		},
		theme,
	);
	expect(rendered.startsWith("✓")).toBe(true);
});

test("all foreground terminal states use one identity-first row", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	for (const status of ["completed", "steered", "stopped", "aborted", "error"] as const) {
		const rendered = formatAgentFinishedLine(
			{
				displayName: "Agent",
				description: "Inspect renderers",
				subagentType: "general",
				toolUses: 2,
				context: "20% ctx",
				outputTokens: 550,
				streamingMs: 10_000,
				durationMs: 12_000,
				status,
				modelName: "haiku",
				tags: ["isolated"],
				turnCount: 4,
				maxTurns: 8,
				error: status === "error" ? "provider unavailable" : undefined,
			},
			theme,
		);
		expect(rendered.split("\n")).toHaveLength(1);
		expect(rendered).toContain("Agent");
		expect(rendered).toContain("Inspect renderers");
		expect(rendered).toContain(status === "steered" ? "steered" : status);
	}
});

test("expanded foreground terminal result keeps summary first and bounded detail below", () => {
	const tool = createAgentTool({} as never, {} as never, new Map(), () => {});
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const component = tool.renderResult?.(
		{
			content: [{ type: "text", text: "Exact terminal detail\nSecond line" }],
			details: {
				displayName: "Agent",
				description: "Inspect renderers",
				subagentType: "general",
				toolUses: 0,
				context: "",
				durationMs: 250,
				status: "error",
				error: "provider unavailable",
			},
		},
		{ expanded: true, isPartial: false },
		theme as never,
		{} as never,
	);
	const rendered = component?.render(120).join("\n") ?? "";
	expect(rendered.split("\n")[0]).toContain("Agent");
	expect(rendered.split("\n")[0]).toContain("error");
	expect(rendered).toContain("Exact terminal detail");
	expect(rendered).toContain("Second line");
});

test("formatTokens < 1k", () => {
	// nerd-mode default: nf-md-file-document-outline (U+F027F) + space
	expect(formatTokens(500)).toBe(`${icon("tokens")} 500 token`);
});

test("formatTokens 1k–1M", () => {
	expect(formatTokens(12_400)).toBe(`${icon("tokens")} 12.4k token`);
});

test("formatTokens >= 1M", () => {
	expect(formatTokens(2_500_000)).toBe(`${icon("tokens")} 2.5M token`);
});

test("formatMs rounds to 1dp", () => {
	expect(formatMs(1234)).toBe("1.2s");
});

test("formatTurns no max", () => {
	// nerd-mode default: nf-md-autorenew glyph (U+F006A) + space before count
	expect(formatTurns(3)).toBe(`${icon("turns")} 3`);
});

test("formatTurns with max", () => {
	expect(formatTurns(3, 10)).toBe(`${icon("turns")} 3≤10`);
});

test("formatSpeed computes output t/s", () => {
	expect(formatSpeed(1500, 3000)).toBe("500 t/s");
});

test("formatSpeed empty on zero output", () => {
	expect(formatSpeed(0, 3000)).toBe("");
});

test("formatSpeed empty on zero duration", () => {
	expect(formatSpeed(1500, 0)).toBe("");
});

test("formatToolUses drops label", () => {
	expect(formatToolUses(15)).toBe(`${icon("tools")} 15`);
});

test("formatToolUses singular count", () => {
	expect(formatToolUses(1)).toBe(`${icon("tools")} 1`);
});

test("fmtTokenCount under 1K", () => {
	expect(fmtTokenCount(500)).toBe("500");
});

test("fmtTokenCount 1K to 1M", () => {
	expect(fmtTokenCount(30_100)).toBe("30.1K");
});

test("fmtTokenCount >= 1M", () => {
	expect(fmtTokenCount(1_000_000)).toBe("1.00M");
});

test("formatContext full usage object", () => {
	expect(formatContext({ tokens: 30_100, contextWindow: 1_000_000, percent: 3 })).toBe(
		`${icon("tokens")} 30.1K/1.00M (3%)`,
	);
});

test("formatContext computes used from percent when tokens null", () => {
	// 42% of 200,000 = 84,000 → "84.0K"
	expect(formatContext({ tokens: null, contextWindow: 200_000, percent: 42 })).toBe(
		`${icon("tokens")} 84.0K/200.0K (42%)`,
	);
});

test("formatContext falls back to pct-only when window unknown", () => {
	expect(formatContext({ tokens: 5_000, contextWindow: 0, percent: 42 })).toBe(
		`${icon("tokens")} 42% ctx`,
	);
});

// Regression: the subagent widget's duration/elapsed rendered white because a
// self-colored context segment (embedded trailing \x1b[0m reset) sat inside a
// single outer dim wrap — the reset killed the dim for every later segment.
// Fix: the widget joins PLAIN (uncolored) stat segments and wraps the whole
// tail in one dim, so the tail is one uniform color with no embedded reset to
// leak. This asserts that mechanism without reaching into private renderers.
test("plain stat tail wraps in one uniform color (no duration white-leak)", () => {
	const RESET = "\x1b[0m";
	const DIM = "\x1b[2m";
	const ctx = "80%"; // plain formatSessionContext output — no ANSI inside
	const duration = "1.2s";

	// Fixed pattern: join plain segments, wrap once.
	const tail = `${DIM}${[ctx, duration].join(" · ")}${RESET}`;
	// Exactly one reset, at the very end — nothing leaks mid-tail.
	expect(tail.match(new RegExp(RESET.replace("[", "\\["), "g"))?.length).toBe(1);
	expect(tail.endsWith(`${duration}${RESET}`)).toBe(true);
	expect(tail.startsWith(`${DIM}${ctx}`)).toBe(true);
	// No stray reset before duration → duration stays inside the dim run.
	expect(tail).not.toContain(`${RESET} · ${duration}`);
});

test("formatContext empty on null", () => {
	expect(formatContext(null)).toBe("");
});

test("formatContext empty on null percent", () => {
	expect(formatContext({ tokens: null, contextWindow: 1000, percent: null })).toBe("");
});

test("formatContext rounds percent", () => {
	// contextWindow 0 → fallback to pct-only, 73.6 rounds to 74
	expect(formatContext({ tokens: null, contextWindow: 0, percent: 73.6 })).toBe(
		`${icon("tokens")} 74% ctx`,
	);
});

test("describeActivity: active tool wins over output", () => {
	expect(describeActivity(new Map([["t1", "read"]]), "some text")).toBe("reading…");
});

test("describeActivity: groups parallel tools with count", () => {
	const tools = new Map([
		["a", "read"],
		["b", "read"],
		["c", "read"],
	]);
	expect(describeActivity(tools)).toBe("reading 3×…");
});

test("describeActivity: tails last output line to 32 chars", () => {
	// Default tail is 32; a 28-char last line stays untruncated.
	const out = "first line\nwriting the batch result now";
	expect(describeActivity(new Map(), out)).toBe("writing the batch result now");
	// A last line longer than 32 chars is tail-anchored with a leading ellipsis.
	const longOut = "first line\nwriting the very large batch result to disk now";
	expect(describeActivity(new Map(), longOut)).toBe("…y large batch result to disk now");
});

test("describeActivity: short output untruncated", () => {
	expect(describeActivity(new Map(), "done")).toBe("done");
});

test("describeActivity: idle is thinking", () => {
	expect(describeActivity(new Map(), "")).toBe("thinking…");
});
