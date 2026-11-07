/**
 * Decide the `isError` override for a finished tool result in the `tool_result` hook.
 *
 * Flag execution failures and unresolved tool calls so the call title matches the error result.
 * Returning only `isError` preserves the original content and details.
 * Auth and other precondition feedback remain unchanged.
 */
export function toolErrorOverride(details: unknown): { isError: true } | undefined {
	if (details && typeof details === "object" && "error" in details) {
		const code = (details as { error?: unknown }).error;
		if (code === "tool_error" || code === "call_failed" || code === "tool_not_found") {
			return { isError: true };
		}
	}
	return undefined;
}
