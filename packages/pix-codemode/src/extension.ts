import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as host from "@earendil-works/pi-coding-agent";
import { once } from "@xynogen/pix-runtime/once";
import { renderCall, renderResult } from "./codemode.ts";

export default function pixCodemodeExtension(pi: ExtensionAPI): void {
	once(pi, "pix-codemode", () => {
		const nested = new Map<string, Map<string, AgentToolResult<unknown>>>();

		pi.on("tool_execution_start", (event) => {
			if (event.toolName === "codemode") nested.set(event.toolCallId, new Map());
		});
		pi.on("tool_execution_end", (event) => {
			if (event.parentToolCallId) {
				nested.get(event.parentToolCallId)?.set(event.toolCallId, {
					...event.result,
					isError: event.isError,
				});
			}
			if (event.toolName === "codemode") nested.delete(event.toolCallId);
		});
		pi.on("tool_execution_update", (event) => {
			if (event.toolName !== "codemode") return;
			const results = nested.get(event.toolCallId);
			const details = event.partialResult?.details as { calls?: { id: string }[] } | undefined;
			if (!results?.size || !details?.calls) return;
			details.calls = details.calls.map((call) => ({ ...call, result: results.get(call.id) }));
		});
		pi.on("tool_result", (event) => {
			if (event.toolName !== "codemode") return;
			const results = nested.get(event.toolCallId);
			if (!results?.size) return;
			const details = event.details as { calls?: { id: string }[] } | undefined;
			return {
				details: {
					...details,
					calls: details?.calls?.map((call) => ({ ...call, result: results.get(call.id) })),
				},
			};
		});
		pi.on("session_shutdown", () => {
			nested.clear();
		});
		const rendererApi = pi as ExtensionAPI & {
			registerToolRenderer?: (resolver: (name: string, next: () => unknown) => unknown) => void;
		};
		if (typeof rendererApi.registerToolRenderer === "function") {
			rendererApi.registerToolRenderer((name, next) =>
				name === "codemode" ? { renderCall, renderResult, renderShell: "self" } : next(),
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
							...(tool.name !== "codemode"
								? {}
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
			if (tools.some((tool) => tool.name === "codemode")) host.createCodemodeExtension()(proxy);
		});
	});
}
