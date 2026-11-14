import type { ToolContent, ToolImageContent, ToolResultLike, ToolTextContent } from "./types.ts";

export function isTextContent(content: ToolContent): content is ToolTextContent {
	return content.type === "text";
}

export function isImageContent(content: ToolContent): content is ToolImageContent {
	return content.type === "image";
}

export function getTextContent(result: ToolResultLike): string {
	return (
		result.content
			?.filter(isTextContent)
			.map((content) => content.text || "")
			.join("\n") ?? ""
	);
}

/** Add renderer metadata without discarding execution metadata from the upstream tool. */
export function setResultDetails<T>(result: ToolResultLike, details: T): void {
	const upstream =
		result.details && typeof result.details === "object"
			? (result.details as Record<string, unknown>)
			: undefined;
	result.details = upstream ? { ...upstream, ...details } : details;
}

export function makeTextResult<TDetails>(
	text: string,
	details: TDetails,
): ToolResultLike<TDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

/** Details of an action tool (download, proc): an outcome plus model-facing lines or an error. */
export interface ActionResultDetails {
	action: string;
	ok: boolean;
	lines: string[];
	error?: string;
}

/** Tool result for an action: the error, else the lines, else `<action> ok`. */
export function makeActionResult<TDetails extends ActionResultDetails>(details: TDetails) {
	return {
		content: [
			{
				type: "text" as const,
				text: details.error ?? (details.lines.join("\n") || `${details.action} ok`),
			},
		],
		details,
		isError: !details.ok,
	};
}
