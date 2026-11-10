import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderCall } from "@xynogen/pix-pretty/utils";
import { runToolExecution, toolFailureResult } from "@xynogen/pix-runtime/tool-execution";
import { Type } from "typebox";
import { fetchConfig } from "./config.ts";
import type { FetchFormat } from "./providers.ts";
import { makeRenderResult } from "./render.ts";
import { runFetch } from "./runner.ts";

type Outcome = "running" | "success" | "cancelled" | "error";
interface Details {
	outcome: Outcome;
	target: string;
	meta: string;
}
function configuredProvider(): string[] | undefined {
	return fetchConfig.provider === "auto" ? undefined : [fetchConfig.provider];
}

export function registerFetchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "fetch",
		label: "Fetch",
		renderShell: "self",
		description: "Fetch a URL as plain text through a configured provider.",
		promptSnippet: "fetch(url, format?, max_characters?)",
		renderCall: renderCall<unknown>("fetch", (args) =>
			String((args as { url?: string }).url ?? ""),
		),
		renderResult: makeRenderResult<Details>({
			tool: "fetch",
			target: (details) => details.target,
			meta: (details) => details.meta,
			status: (details) =>
				details.outcome === "error"
					? "error"
					: details.outcome === "cancelled"
						? "warning"
						: "success",
		}),
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			format: Type.Optional(
				StringEnum(["markdown", "text", "html"] as const, {
					description: "Upstream provider format. The tool always returns plain text.",
				}),
			),
			max_characters: Type.Optional(
				Type.Number({ description: "Max characters (default 1000, 0 = unlimited)", default: 1000 }),
			),
		}),
		async execute(_id, raw, signal, onUpdate) {
			const params = raw as {
				url: string;
				format?: FetchFormat;
				max_characters?: number;
			};
			return runToolExecution({
				signal,
				onUpdate,
				onError: (error, cancelled) =>
					toolFailureResult(error, cancelled, params.url, "Fetch cancelled."),
				execute: async ({ update }) => {
					update({
						content: [{ type: "text", text: `Fetching: ${params.url}...` }],
						details: { outcome: "running", target: params.url, meta: "running" },
					});
					const url = new URL(params.url);
					if (url.protocol !== "http:" && url.protocol !== "https:") {
						throw new Error("Fetch URL must use HTTP or HTTPS");
					}
					const maxCharacters = Math.max(params.max_characters ?? 1000, 0);
					const result = await runFetch(
						{
							url: params.url,
							format: params.format ?? "markdown",
							maxCharacters,
							signal,
						},
						configuredProvider(),
					);
					const page = result.data;
					const body = [page.title ? `# ${page.title}` : "", `URL: ${page.url}`, "", page.content]
						.filter((line, index) => line || index === 2)
						.join("\n");
					const text =
						maxCharacters > 0 && body.length > maxCharacters
							? `${body.slice(0, maxCharacters)}\n\n[truncated]`
							: body;
					const fallbackMeta = result.errors.length > 0 ? ` · ${result.errors.length} failed` : "";
					return {
						content: [{ type: "text", text: text.slice(0, 20_000) }],
						details: {
							outcome: "success",
							target: params.url,
							meta: `${body.length} chars · ${result.provider}${fallbackMeta}`,
						},
					};
				},
			});
		},
	});
}
