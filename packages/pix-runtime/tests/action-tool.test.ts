import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineActionTool, mergeActionSchemas } from "../src/action-tool.ts";

const calls: string[] = [];
function tool(name: string, parameters: ReturnType<typeof Type.Object>): ToolDefinition {
	return {
		name,
		label: name,
		description: name,
		parameters,
		async execute(_id, params) {
			calls.push(`${name}:${JSON.stringify(params)}`);
			return { content: [{ type: "text", text: name }], details: { name } };
		},
		renderCall: () => ({ render: () => [`call ${name}`], invalidate() {} }),
		renderResult: () => ({ render: () => [`result ${name}`], invalidate() {} }),
	};
}

const actions = {
	outline: {
		tool: tool("outline", Type.Object({ path: Type.String({ description: "File." }) })),
		summary: "list declarations",
	},
	search: {
		tool: tool(
			"search",
			Type.Object({
				pattern: Type.String(),
				path: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Integer({ maximum: 5 })),
			}),
		),
		summary: "structural search",
	},
};
const merged = defineActionTool({ name: "ast", label: "AST", description: "AST tools", actions });
const run = (params: Record<string, unknown>) =>
	merged.execute("id", params as never, undefined, undefined, {} as never);

describe("mergeActionSchemas", () => {
	test("is one flat object with action required and fields tagged by action", () => {
		const schema = mergeActionSchemas(actions) as unknown as {
			type: string;
			required: string[];
			properties: Record<string, { enum?: string[]; description?: string; maximum?: number }>;
		};
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["action"]);
		expect(schema.properties.action?.enum).toEqual(["outline", "search"]);
		expect(schema.properties.action?.description).toBe(
			'"outline": list declarations "search": structural search',
		);
		expect(schema.properties.path?.description).toBe("[outline REQUIRED|search] File.");
		expect(schema.properties.pattern?.description).toBe("[search REQUIRED]");
		// Limits differ per action, so only the action's own schema enforces them.
		expect(schema.properties.limit?.maximum).toBeUndefined();
	});

	test("rejects an action whose schema already has an action field", () => {
		const clash = { x: { tool: tool("x", Type.Object({ action: Type.String() })), summary: "x" } };
		expect(() => mergeActionSchemas(clash)).toThrow('"x" already has an action field');
	});

	test("rejects a shared field whose type differs between actions", () => {
		const clash = {
			a: { tool: tool("a", Type.Object({ path: Type.String() })), summary: "a" },
			b: { tool: tool("b", Type.Object({ path: Type.Array(Type.String()) })), summary: "b" },
		};
		expect(() => mergeActionSchemas(clash)).toThrow('field "path" has a different type in "b"');
	});
});

describe("defineActionTool", () => {
	test("routes execute to the action without the action field", async () => {
		calls.length = 0;
		const result = await run({ action: "search", pattern: "foo($A)", limit: 3 });
		expect(calls).toEqual(['search:{"pattern":"foo($A)","limit":3}']);
		expect(result.details).toEqual({ name: "search" });
	});

	test("checks the action's own required fields and limits", async () => {
		await expect(run({ action: "outline" })).rejects.toThrow(/ast outline[\s\S]*path: missing/);
		await expect(run({ action: "search", pattern: "x", limit: 9 })).rejects.toThrow(
			/ast search[\s\S]*limit: expected <= 5/,
		);
	});

	test("names the valid actions for an unknown action", async () => {
		await expect(run({ action: "nope" })).rejects.toThrow(
			'ast: unknown action "nope". Use one of: outline, search.',
		);
	});

	test("keeps the actions' render shell and rejects mixed shells", () => {
		expect(merged.renderShell).toBeUndefined();
		const self = { ...tool("s", Type.Object({})), renderShell: "self" as const };
		const only = defineActionTool({
			name: "x",
			label: "x",
			description: "x",
			actions: { s: { tool: self, summary: "s" } },
		});
		expect(only.renderShell).toBe("self");
		expect(() =>
			defineActionTool({
				name: "x",
				label: "x",
				description: "x",
				actions: {
					s: { tool: self, summary: "s" },
					d: { tool: tool("d", Type.Object({})), summary: "d" },
				},
			}),
		).toThrow('"x" actions mix render shells');
	});

	test("routes renderers by the call's action", () => {
		const context = { args: { action: "search" } } as never;
		expect(merged.renderCall?.({ action: "search" }, {} as never, context).render(80)).toEqual([
			"call search",
		]);
		const result = { content: [], details: {} };
		expect(
			merged
				.renderResult?.(result, { expanded: false, isPartial: false }, {} as never, context)
				.render(80),
		).toEqual(["result search"]);
	});
});
