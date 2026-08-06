import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type LoadExtensionsResult,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export const BTW_SYSTEM_PROMPT =
	"You are Pix Coding Agent. You help users accomplish any task they request.";

export interface BtwSnapshot {
	cwd: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
}

export interface BtwRunOptions {
	question: string;
	snapshot: BtwSnapshot;
	ctx: ExtensionContext;
	onSession?: (session: AgentSession) => void;
	onTextDelta?: (delta: string, fullText: string) => void;
	onToolStart?: (toolName: string) => void;
	onToolEnd?: (toolName: string) => void;
	/** Called after each completed turn with the running turn count. */
	onTurnEnd?: (turnCount: number) => void;
	/** Called once per assistant message_end with that message's output tokens. */
	onOutputTokens?: (outputTokens: number) => void;
}

export interface BtwRunResult {
	text: string;
	/** Reasoning/thinking captured from the child session (empty when none). */
	thinking: string;
	session: AgentSession;
}

/** Capture main-session settings at invocation time so later changes do not affect a running aside. */
export function snapshotMainSettings(
	ctx: Pick<ExtensionContext, "cwd" | "model">,
	thinkingLevel: ThinkingLevel,
	activeToolNames: string[],
): BtwSnapshot {
	if (!ctx.model) throw new Error("No model is selected in the main session.");
	return {
		cwd: ctx.cwd,
		model: ctx.model as Model<Api>,
		thinkingLevel,
		activeToolNames: [...activeToolNames],
	};
}

/** Preserve the main session's active tool selection exactly, while removing duplicates. */
export function selectBtwTools(activeToolNames: string[]): string[] {
	return [...new Set(activeToolNames)];
}

/**
 * Keep extension tools and policies, but remove per-turn system-prompt mutators.
 * This preserves the deliberately lean /btw identity even when pix-prompts,
 * optimizer nudges, or project extensions normally append instructions.
 */
export function makeLeanExtensions(base: LoadExtensionsResult): LoadExtensionsResult {
	return {
		...base,
		extensions: base.extensions.map((extension) => {
			// Preserve our final inline prompt override; suppress every discovered
			// extension's per-turn system-prompt mutation.
			if (extension.path.startsWith("<inline:")) return extension;
			const handlers = new Map(extension.handlers);
			handlers.delete("before_agent_start");
			return { ...extension, handlers };
		}),
	};
}

/** Extract the final assistant text if no streaming deltas were observed. */
export function lastAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as AssistantMessage | undefined;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

/**
 * Run one isolated, in-memory /btw question.
 *
 * The child discovers the same extensions, skills, credentials, model registry,
 * working directory, and settings files as the main session. Its system prompt
 * is replaced with the lean Pix identity, and its conversation starts empty.
 */
export async function runBtw(options: BtwRunOptions): Promise<BtwRunResult> {
	const { question, snapshot, ctx } = options;
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(snapshot.cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd: snapshot.cwd,
		agentDir,
		settingsManager,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", () => ({ systemPrompt: BTW_SYSTEM_PROMPT }));
			},
		],
		extensionsOverride: makeLeanExtensions,
		systemPromptOverride: () => BTW_SYSTEM_PROMPT,
		appendSystemPromptOverride: () => [],
	});
	await loader.reload();

	const tools = selectBtwTools(snapshot.activeToolNames);

	const { session } = await createAgentSession({
		cwd: snapshot.cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(snapshot.cwd),
		settingsManager,
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		tools,
		resourceLoader: loader,
	});
	session.setSessionName("btw");
	await session.bindExtensions({
		mode: ctx.mode,
		onError: () => {},
	});
	options.onSession?.(session);

	let text = "";
	let thinking = "";
	let turnCount = 0;
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_start" && event.message.role === "assistant") {
			text = "";
			thinking = "";
		}
		if (event.type === "message_update") {
			const ev = event.assistantMessageEvent;
			if (ev.type === "text_delta") {
				text += ev.delta;
				options.onTextDelta?.(ev.delta, text);
			} else if (ev.type === "thinking_delta") {
				thinking += ev.delta;
			}
		}
		if (event.type === "tool_execution_start") options.onToolStart?.(event.toolName);
		if (event.type === "tool_execution_end") options.onToolEnd?.(event.toolName);
		if (event.type === "turn_end") options.onTurnEnd?.(++turnCount);
		if (event.type === "message_end" && event.message.role === "assistant") {
			const output = event.message.usage?.output;
			if (typeof output === "number" && output > 0) options.onOutputTokens?.(output);
		}
	});

	try {
		await session.prompt(question, { source: "extension" });
		return {
			text: text.trim() || lastAssistantText(session.messages),
			thinking: thinking.trim(),
			session,
		};
	} catch (error) {
		session.dispose();
		throw error;
	} finally {
		unsubscribe();
	}
}
