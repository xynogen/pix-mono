import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as host from "@earendil-works/pi-coding-agent";
import { once } from "@xynogen/pix-runtime/once";
import { renderCall, renderResult } from "./codemode.ts";

export default function pixCodemodeExtension(pi: ExtensionAPI): void {
	once(pi, "pix-codemode", () => {
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
		host.createCodemodeExtension()(proxy);
	});
}
