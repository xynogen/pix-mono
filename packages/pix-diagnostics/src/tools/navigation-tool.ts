/**
 * navigation-tool.ts — the `lsp_navigation` tool.
 *
 * LSP navigation: definition, type definition, implementation, references,
 * hover, document symbols, workspace symbols, rename, and call hierarchy.
 * `rename` previews the edits it would make; it does not write files. The agent
 * applies them with the edit tool, so the mutation stays visible.
 *
 * Public line/character are one-based; the manager converts to LSP zero-based.
 * When `symbol` is given without `character`, the tool reads the named line and
 * selects the first exact identifier match, rejecting ambiguous lines.
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	formatCollapsedToolRow,
	formatToolCallTitle,
	frameToolResult,
	hideCollapsedToolCall,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { Type } from "typebox";
import type {
	LspManager,
	NavigationOperation,
	NavigationRequest,
	NavigationResult,
} from "../lsp/manager.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const HOVER_MAX_BYTES = 4 * 1024;
const HOVER_MAX_LINES = 60;

export interface NavigationToolDeps {
	manager: LspManager;
	cwd: string;
}

interface NavigationDetails {
	_type: "pixNavigation";
	outcome: "success" | "empty" | "unsupported" | "error";
	operation: NavigationOperation;
	results: number;
	truncated: boolean;
}

/** Find the one-based column of the first exact identifier match on a line. */
function columnForSymbol(cwd: string, path: string, line: number, symbol: string): number {
	const abs = resolve(cwd, path);
	const text = readFileSync(abs, "utf8").split("\n")[line - 1] ?? "";
	// ReDoS-safe: every regex metacharacter in `symbol` is escaped before use, so
	// the pattern is a literal word match with no attacker-controlled quantifiers.
	const pattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
	const matches = [...text.matchAll(pattern)];
	if (matches.length === 0) throw new Error(`symbol "${symbol}" not found on line ${line}`);
	if (matches.length > 1) {
		throw new Error(`symbol "${symbol}" is ambiguous on line ${line}; pass character instead`);
	}
	return (matches[0]?.index ?? 0) + 1;
}

function formatResult(cwd: string, r: NavigationResult): string {
	if (r.kind === "hover") return r.text;
	if (r.kind === "symbol") {
		const loc = r.filePath ? ` ${relative(cwd, r.filePath)}:${r.line}:${r.character}` : "";
		return `${r.name}${loc}`;
	}
	if (r.kind === "call") {
		return `${r.name}  ${relative(cwd, r.filePath)}:${r.line}:${r.character}`;
	}
	if (r.kind === "edit") {
		return `${relative(cwd, r.filePath)}:${r.line}:${r.character} → "${r.newText}"`;
	}
	return `${relative(cwd, r.filePath)}:${r.line}:${r.character}`;
}

function capHover(text: string): { text: string; truncated: boolean } {
	let out = text;
	let truncated = false;
	const lines = out.split("\n");
	if (lines.length > HOVER_MAX_LINES) {
		out = lines.slice(0, HOVER_MAX_LINES).join("\n");
		truncated = true;
	}
	if (Buffer.byteLength(out, "utf8") > HOVER_MAX_BYTES) {
		out = out.slice(0, HOVER_MAX_BYTES);
		truncated = true;
	}
	return { text: out, truncated };
}

export function registerNavigationTool(pi: ExtensionAPI, deps: NavigationToolDeps): void {
	const { manager, cwd } = deps;

	pi.registerTool({
		name: "lsp_navigation",
		label: "Navigation",
		renderShell: "self",
		description:
			"LSP navigation: definition, typeDefinition, implementation, references, hover, " +
			"documentSymbol, workspaceSymbol, rename, callHierarchy. Positions are one-based. Pass " +
			"path + line + character or path + line + symbol; workspaceSymbol takes query; rename " +
			"takes newName and previews edits; callHierarchy takes direction.",
		promptSnippet:
			"lsp_navigation(operation, path?, line?, character?, symbol?, query?, limit?) — one-based positions.",
		parameters: Type.Object({
			operation: StringEnum(
				[
					"definition",
					"typeDefinition",
					"implementation",
					"references",
					"hover",
					"documentSymbol",
					"workspaceSymbol",
					"rename",
					"callHierarchy",
				] as const,
				{ description: "Navigation operation." },
			),
			path: Type.Optional(Type.String({ description: "File path (not for workspaceSymbol)." })),
			line: Type.Optional(Type.Integer({ minimum: 1, description: "One-based line." })),
			character: Type.Optional(Type.Integer({ minimum: 1, description: "One-based column." })),
			symbol: Type.Optional(
				Type.String({ description: "Identifier on `line` to locate when character is absent." }),
			),
			query: Type.Optional(Type.String({ description: "workspaceSymbol query." })),
			newName: Type.Optional(Type.String({ description: "New name for rename." })),
			direction: Type.Optional(
				StringEnum(["incoming", "outgoing"] as const, {
					description: "callHierarchy direction (default incoming).",
				}),
			),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: "Max results (default 100)." }),
			),
		}),

		renderCall(args, theme, context) {
			const t = theme as Theme;
			if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
				return new Text("", 0, 0);
			const a = args as { operation?: string; path?: string; query?: string };
			const title = formatToolCallTitle(t, "lsp_navigation", context);
			const op = t.fg("muted", a.operation ?? "");
			const target = a.path ? t.fg("dim", a.path) : a.query ? t.fg("dim", `“${a.query}”`) : "";
			return new Text(`${title} ${op} ${target}`.trimEnd(), 0, 0);
		},

		renderResult(result, options, theme, context) {
			const t = theme as Theme;
			const text = result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
			const details = result.details as NavigationDetails | undefined;
			const isError = context.isError || details?.outcome === "error";
			const glyph = isError ? icon("status.error") : icon("status.done");
			const role = isError ? "error" : "success";
			const body = new Text(`${t.fg(role, glyph)} ${text}`, 0, 0);
			if (options.isPartial) return body;
			if (!details) return frameToolResult(body, theme, isError);
			if (
				tickCollapse(
					"lsp_navigation",
					context.state as CollapseState,
					context.invalidate,
					context.expanded,
				)
			)
				return new Text(
					formatCollapsedToolRow(
						t,
						"lsp_navigation",
						details.operation,
						`${details.results} results`,
						isError ? "error" : "success",
					),
					0,
					0,
				);
			return frameToolResult(body, theme, isError);
		},

		async execute(_id, params) {
			const operation = params.operation as NavigationOperation;
			const limit = Math.min(MAX_LIMIT, (params.limit as number | undefined) ?? DEFAULT_LIMIT);

			const request: NavigationRequest = { operation, limit };

			if (operation === "workspaceSymbol") {
				if (!params.query) throw new Error("workspaceSymbol requires query");
				request.query = params.query as string;
			} else {
				const path = params.path as string | undefined;
				if (!path) throw new Error(`${operation} requires path`);
				request.path = resolve(cwd, path);

				if (operation !== "documentSymbol") {
					let character = params.character as number | undefined;
					const line = params.line as number | undefined;
					const symbol = params.symbol as string | undefined;
					if (character === undefined) {
						if (line === undefined || symbol === undefined) {
							throw new Error(
								`${operation} requires a position (line + character) or (line + symbol)`,
							);
						}
						character = columnForSymbol(cwd, path, line, symbol);
					}
					if (line === undefined) throw new Error(`${operation} requires line`);
					request.line = line;
					request.character = character;
				}

				if (operation === "rename") {
					if (!params.newName) throw new Error("rename requires newName");
					request.newName = params.newName as string;
				}
				if (operation === "callHierarchy") {
					request.direction =
						(params.direction as "incoming" | "outgoing" | undefined) ?? "incoming";
				}
			}

			const results = await manager.navigate(request);
			const capped = results.slice(0, limit);

			let truncated = capped.length < results.length;
			const lines: string[] = [];
			for (const r of capped) {
				if (r.kind === "hover") {
					const h = capHover(r.text);
					if (h.truncated) truncated = true;
					lines.push(h.text);
				} else {
					lines.push(formatResult(cwd, r));
				}
			}

			const outcome: NavigationDetails["outcome"] = capped.length > 0 ? "success" : "empty";
			const details: NavigationDetails = {
				_type: "pixNavigation",
				outcome,
				operation,
				results: capped.length,
				truncated,
			};
			const text = lines.length > 0 ? lines.join("\n") : "No results.";
			return { content: [{ type: "text" as const, text }], details };
		},
	});
}
