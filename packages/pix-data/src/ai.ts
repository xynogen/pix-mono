/**
 * ai.ts — the pi-ai surface for feature packages: model and message types,
 * classifier types, and the completion helpers. Named re-exports only.
 */

export type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	ImageContent,
	Message,
	Model,
	RefreshModelsContext,
	TextContent,
	ThinkingLevel,
	ToolCall,
} from "@earendil-works/pi-ai";
export {
	contentText,
	formatUserAgent,
	getSupportedThinkingLevels,
	retryAssistantCall,
	StringEnum,
	validateToolArguments,
} from "@earendil-works/pi-ai";
export { complete, completeSimple } from "@earendil-works/pi-ai/compat";

/** pi-ai's built-in providers. Lazy: the module is large and only classifiers need it. */
export async function builtinProviders() {
	return (await import("@earendil-works/pi-ai/providers/all")).builtinProviders();
}
