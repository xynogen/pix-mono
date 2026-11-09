export function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new Error(String(signal.reason ?? "MCP request aborted"));
}

export { abortable } from "@xynogen/pix-runtime/abort";
