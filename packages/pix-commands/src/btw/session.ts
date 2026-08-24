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
	/** Optional read-only preamble (e.g. recent main-session turns from `--ctx`). */
	contextPreamble?: string;
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

/** How many recent conversation turns `--ctx` folds into the aside. */
export const BTW_CTX_TURNS = 10;

/** One flattened conversation line: role + its text (tool noise dropped). */
interface CtxLine {
	role: string;
	text: string;
}

/**
 * Flatten the main session's recent user/assistant turns into a plain-text
 * preamble for `--ctx`. Reads `buildContextEntries()` (the active,
 * compaction-aware list), keeps only message entries with extractable text,
 * and returns the last `turns` of them. Returns "" when there's nothing to show
 * so callers can skip the preamble entirely.
 *
 * Kept a pure function over a minimal entry shape (not the full SessionManager)
 * so it unit-tests without a Pi host.
 */
export function buildContextPreamble(
	entries: readonly { type: string; message?: unknown }[],
	turns = BTW_CTX_TURNS,
): string {
	const lines: CtxLine[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as { role?: string; content?: unknown } | undefined;
		if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
		const text = extractMessageText(msg.content);
		if (text) lines.push({ role: msg.role, text });
	}
	const recent = lines.slice(-Math.max(1, turns));
	if (recent.length === 0) return "";
	const body = recent
		.map((l) => `${l.role === "user" ? "User" : "Assistant"}: ${l.text}`)
		.join("\n\n");
	return `Recent conversation from the main session (most recent ${recent.length} turn(s), read-only context):\n\n${body}`;
}

/** Pull plain text out of a message's content (string or content-block array). */
function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => {
			const block = b as { type?: string; text?: unknown };
			return block.type === "text" && typeof block.text === "string";
		})
		.map((b) => b.text)
		.join("\n")
		.trim();
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

	const prompt = options.contextPreamble
		? `${options.contextPreamble}\n\n---\n\nQuestion: ${question}`
		: question;
	try {
		await session.prompt(prompt, { source: "extension" });
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
