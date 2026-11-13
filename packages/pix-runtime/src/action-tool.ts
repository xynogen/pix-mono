/**
 * action-tool — merge several tool definitions into one tool with an `action`.
 *
 * Each action keeps its own parameters, execute and renderers; this layer only
 * routes by `action`. The merged schema is one flat object (root
 * `type: "object"`), not a union: strict OpenAI-compatible providers reject a
 * root `anyOf`. Per-action required fields and limits are checked at call time
 * against that action's own schema, so a bad call names the action and field.
 */

import { type JsonObject, validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";

// Each action keeps its own params/details types, so the merged tool is untyped. ToolDefinition
// is invariant in its params (execute takes them, renderers return them), so no non-any type accepts
// every action's definition.
// biome-ignore lint/suspicious/noExplicitAny: erased-generic registry of heterogeneous tool definitions
type AnyDefinition = ToolDefinition<any, any, any>;

export interface ActionSpec {
	/** The original tool definition; its `name` is ignored. */
	tool: AnyDefinition;
	/** One line shown in the `action` description. */
	summary: string;
}

interface ObjectSchema {
	properties?: Record<string, Record<string, unknown>>;
	required?: string[];
}

/** Flat merged schema: `action` plus every action field, tagged with the actions that use it. */
export function mergeActionSchemas(actions: Record<string, ActionSpec>): TSchema {
	const names = Object.keys(actions);
	const users = new Map<string, string[]>();
	const shapes = new Map<string, Record<string, unknown>>();
	for (const [action, { tool }] of Object.entries(actions)) {
		const schema = tool.parameters as ObjectSchema;
		for (const [key, prop] of Object.entries(schema.properties ?? {})) {
			if (key === "action") throw new Error(`action-tool: "${action}" already has an action field`);
			const required = schema.required?.includes(key) ? " REQUIRED" : "";
			users.set(key, [...(users.get(key) ?? []), `${action}${required}`]);
			const first = shapes.get(key);
			if (!first) shapes.set(key, prop);
			else if (JSON.stringify(first.type) !== JSON.stringify(prop.type))
				throw new Error(`action-tool: field "${key}" has a different type in "${action}"`);
		}
	}
	const properties: Record<string, unknown> = {
		action: {
			type: "string",
			enum: names,
			description: names.map((name) => `"${name}": ${actions[name]?.summary}`).join(" "),
		},
	};
	for (const [key, prop] of shapes) {
		const description = typeof prop.description === "string" ? ` ${prop.description}` : "";
		// Actions may share a field with different limits; each action's own schema enforces them.
		const { maximum: _max, minimum: _min, default: _default, ...shape } = prop;
		properties[key] = { ...shape, description: `[${users.get(key)?.join("|")}]${description}` };
	}
	return Type.Unsafe({ type: "object", required: ["action"], properties });
}

/** Check the call against the action's own schema, so its required fields and limits hold. */
function actionArgs(name: string, action: string, spec: ActionSpec, params: JsonObject) {
	const { action: _action, ...rest } = params;
	try {
		const label = `${name} ${action}`;
		return validateToolArguments(
			{ name: label, description: "", parameters: spec.tool.parameters },
			{ type: "toolCall", id: "", name: label, arguments: rest },
		) as JsonObject;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message.split("\n\nReceived arguments:")[0]);
	}
}

/**
 * Build one tool from several. `renderCall`/`renderResult` route to the action
 * named in the call args; inner renderers keep their own titles, so their
 * definitions should already render the merged name.
 */
export function defineActionTool(options: {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	exposure?: AnyDefinition["exposure"];
	actions: Record<string, ActionSpec>;
}): AnyDefinition {
	const { name, actions } = options;
	const fallback = Object.values(actions)[0]?.tool;
	// One card shell per tool: the inner renderers must agree on who draws the frame.
	const shells = new Set(Object.values(actions).map(({ tool }) => tool.renderShell ?? "default"));
	if (shells.size > 1) throw new Error(`action-tool: "${name}" actions mix render shells`);
	const pick = (args: unknown) => {
		const action = (args as { action?: unknown } | undefined)?.action;
		return (typeof action === "string" ? actions[action]?.tool : undefined) ?? fallback;
	};
	return {
		name,
		label: options.label,
		description: options.description,
		...(options.promptSnippet ? { promptSnippet: options.promptSnippet } : {}),
		...(options.promptGuidelines ? { promptGuidelines: options.promptGuidelines } : {}),
		...(options.exposure ? { exposure: options.exposure } : {}),
		...(fallback?.renderShell ? { renderShell: fallback.renderShell } : {}),
		parameters: mergeActionSchemas(actions),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// SAFETY: the host validated params against the merged object schema.
			const raw = params as JsonObject;
			const action = String(raw.action);
			const spec = actions[action];
			if (!spec)
				throw new Error(
					`${name}: unknown action "${action}". Use one of: ${Object.keys(actions).join(", ")}.`,
				);
			return spec.tool.execute(
				toolCallId,
				actionArgs(name, action, spec, raw),
				signal,
				onUpdate,
				ctx,
			);
		},
		renderCall: (args, theme, context) => pick(args)?.renderCall?.(args, theme, context),
		renderResult: (result, opts, theme, context) =>
			pick(context.args)?.renderResult?.(result, opts, theme, context),
	} as AnyDefinition;
}
