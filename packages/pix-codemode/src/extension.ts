import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as host from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	formatCollapsedToolRow,
	formatToolCallTitle,
	frameToolResult,
	hideCollapsedToolCall,
	pluralize,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { once } from "@xynogen/pix-runtime/once";
import { renderCall, renderResult } from "./codemode.ts";

export default function pixCodemodeExtension(pi: ExtensionAPI): void {
	once(pi, "pix-codemode", () => {
		const searchRenderers = {
			renderShell: "self" as const,
			renderCall: ((args, theme, ctx) => {
				const text = new Text("", 0, 0);
				if (
					hideCollapsedToolCall(ctx.state as CollapseState, ctx.expanded, (value) =>
						text.setText(value),
					)
				)
					return text;
				text.setText(
					`${formatToolCallTitle(theme, "tool_search", ctx)} ${theme.fg("dim", String((args as { query?: string }).query ?? ""))}`,
				);
				return text;
			}) as NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"]>,
			renderResult: ((result, options, theme, ctx) => {
				const state = ctx.state as CollapseState;
				const loaded = (result.details as { loaded?: string[] } | undefined)?.loaded ?? [];
				if (
					!options.isPartial &&
					tickCollapse("tool_search", state, ctx.invalidate, options.expanded)
				) {
					return new Text(
						formatCollapsedToolRow(
							theme,
							"tool_search",
							loaded.join(", "),
							pluralize(loaded.length, "tool"),
							ctx.isError ? "error" : "success",
						),
						0,
						0,
					);
				}
				const body = result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const text = new Text(body, 0, 0);
				return options.isPartial ? text : frameToolResult(text, theme, ctx.isError);
			}) as NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>,
		};
		const rendererApi = pi as ExtensionAPI & {
			registerToolRenderer?: (resolver: (name: string, next: () => unknown) => unknown) => void;
		};
		if (typeof rendererApi.registerToolRenderer === "function") {
			rendererApi.registerToolRenderer((name, next) =>
				name === "codemode"
					? { renderCall, renderResult, renderShell: "self" }
					: name === "tool_search"
						? searchRenderers
						: next(),
			);
			return;
		}
		if (typeof host.createCodemodeExtension !== "function") {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.notify("pix-codemode requires a Pi host with createCodemodeExtension.", "warning");
			});
			return;
		}
		const proxy = new Proxy(pi, {
			get(target, key) {
				if (key === "registerTool") {
					return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) =>
						pi.registerTool({
							...tool,
							...(tool.name === "tool_search"
								? searchRenderers
								: {
										renderCall: renderCall as unknown as NonNullable<typeof tool.renderCall>,
										renderResult: renderResult as unknown as NonNullable<typeof tool.renderResult>,
										renderShell: "self" as const,
									}),
						});
				}
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		// ponytail: older hosts lack the renderer hook. Keep their existing tool wrapper.
		pi.on("session_start", () => {
			const tools = pi.getAllTools();
			if (tools.some((tool) => tool.name === "tool_search"))
				host.createToolSearchExtension()(proxy);
			if (tools.some((tool) => tool.name === "codemode")) host.createCodemodeExtension()(proxy);
		});
	});
}
