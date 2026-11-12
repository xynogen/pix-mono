/** The `mcp` proxy tool: parameter schema and the mode dispatcher behind execute. */

import { StringEnum } from "@xynogen/pix-data/ai";
import type { ToolInfo } from "@xynogen/pix-runtime/host";
import { Type } from "typebox";
import {
	executeAuthComplete,
	executeAuthStart,
	executeCall,
	executeConnect,
	executeDescribe,
	executeList,
	executeSearch,
	executeStatus,
	executeUiMessages,
} from "./proxy-modes.ts";
import type { McpExtensionState } from "./state.ts";

export interface ProxyParams {
	tool?: string;
	args?: string;
	connect?: string;
	describe?: string;
	search?: string;
	regex?: boolean;
	includeSchemas?: boolean;
	server?: string;
	limit?: number;
	action?: string;
}

export const proxyParameters = Type.Object({
	tool: Type.Optional(
		Type.String({ description: "Optional. Tool to call. Omit unless calling a tool." }),
	),
	args: Type.Optional(
		Type.String({
			description: "Optional. Arguments as a JSON object string, for tool/connect/auth-complete.",
		}),
	),
	connect: Type.Optional(
		Type.String({
			description:
				'Optional. Server to connect or refresh. Omit unless reconnecting. Ephemeral env via args, e.g. args: \'{"env":{"API_KEY":"sk-..."}}\' — never persisted.',
		}),
	),
	describe: Type.Optional(
		Type.String({ description: "Optional. Tool whose schema to show. Omit otherwise." }),
	),
	search: Type.Optional(
		Type.String({ description: "Optional. Find tools by name or description." }),
	),
	server: Type.Optional(
		Type.String({
			description: "Optional. Alone: list this server's tools. With tool/search: filter.",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: "Optional. Max discovery results (default 12, max 50)." }),
	),
	includeSchemas: Type.Optional(
		Type.Boolean({ description: "Optional. Include schemas in search (default false)." }),
	),
	regex: Type.Optional(
		Type.Boolean({ description: "Optional. Treat search as regex (default false)." }),
	),
	action: Type.Optional(
		StringEnum(["auth-start", "auth-complete", "ui-messages"] as const, {
			description:
				"Optional. Omit for normal use. auth-start/auth-complete: OAuth login (needs server). ui-messages: read results after an MCP UI window closed.",
		}),
	),
});

/** `args` must be a JSON object string; anything else is a model error worth reporting. */
export function parseProxyArgs(raw: string | undefined): Record<string, unknown> | undefined {
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		if (error instanceof SyntaxError)
			throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
		throw error;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		const gotType = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
		throw new Error(`Invalid args: expected a JSON object, got ${gotType}`);
	}
	return parsed as Record<string, unknown>;
}

const text = (value: string) => [{ type: "text" as const, text: value }];

function authStart(state: McpExtensionState, server: string | undefined) {
	if (!server)
		return {
			content: text(
				'auth-start requires `server`. Example: mcp({ action: "auth-start", server: "linear-server" })',
			),
			details: { mode: "auth-start", error: "missing_server" },
		};
	return executeAuthStart(state, server);
}

function authComplete(
	state: McpExtensionState,
	server: string | undefined,
	args: Record<string, unknown> | undefined,
) {
	if (!server)
		return {
			content: text("auth-complete requires `server`."),
			details: { mode: "auth-complete", error: "missing_server" },
		};
	const input = args?.redirectUrl ?? args?.code ?? args?.input;
	if (typeof input !== "string" || input.trim().length === 0)
		return {
			content: text("auth-complete requires args with `redirectUrl`, `code`, or `input`."),
			details: { mode: "auth-complete", error: "missing_input" },
		};
	return executeAuthComplete(state, server, input);
}

function connect(
	state: McpExtensionState,
	server: string,
	args: Record<string, unknown> | undefined,
	signal: AbortSignal | undefined,
) {
	const env = args?.env;
	if (
		env !== undefined &&
		(typeof env !== "object" ||
			env === null ||
			Array.isArray(env) ||
			Object.values(env).some((v) => typeof v !== "string"))
	) {
		throw new Error(
			'Invalid env: expected a JSON object of strings, e.g. args: \'{"env":{"API_KEY":"sk-..."}}\'',
		);
	}
	return executeConnect(state, server, signal, env as Record<string, string> | undefined);
}

/** Pick one proxy mode from the params. Order matters: explicit auth actions, then tool calls. */
export function runProxyMode(
	state: McpExtensionState,
	params: ProxyParams,
	args: Record<string, unknown> | undefined,
	options: {
		signal: AbortSignal | undefined;
		getPiTools: () => ToolInfo[];
		defaultDiscoveryLimit: number | undefined;
	},
) {
	const { signal, defaultDiscoveryLimit } = options;
	if (params.action === "auth-start") return authStart(state, params.server);
	if (params.action === "auth-complete") return authComplete(state, params.server, args);
	if (params.tool)
		return executeCall(state, params.tool, args, params.server, options.getPiTools, signal);
	if (params.connect) return connect(state, params.connect, args, signal);
	if (params.describe) return executeDescribe(state, params.describe);
	if (params.search)
		return executeSearch(
			state,
			params.search,
			params.regex,
			params.server,
			params.includeSchemas,
			params.limit ?? defaultDiscoveryLimit,
		);
	if (params.server)
		return executeList(state, params.server, params.limit ?? defaultDiscoveryLimit);
	// Weak models fill every optional field; a stray action must not shadow a real mode.
	if (params.action === "ui-messages") return executeUiMessages(state);
	return executeStatus(state);
}
