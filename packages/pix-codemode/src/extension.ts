import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as host from "@earendil-works/pi-coding-agent";
import { once } from "@xynogen/pix-runtime/once";
import { renderCall, renderResult } from "./codemode.ts";

export default function pixCodemodeExtension(pi: ExtensionAPI): void {
	once(pi, "pix-codemode", () => {
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
							// The host supplies the theme and component methods used by these renderers.
							renderCall: renderCall as unknown as NonNullable<typeof tool.renderCall>,
							renderResult: renderResult as unknown as NonNullable<typeof tool.renderResult>,
							renderShell: "self",
						});
				}
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		// ponytail: older hosts lack the renderer hook. Keep their existing tool wrapper.
		pi.on("session_start", () => {
			if (!pi.getAllTools().some((tool) => tool.name === "codemode")) return;
			host.createCodemodeExtension()(proxy);
		});
	});
}
