/**
 * mode.ts — shared plumbing for prompt-injection optimizer modes.
 *
 * caveman.ts and ponytail.ts are the same *kind* of tool: a level enum, a
 * system-prompt fragment injected via before_agent_start, and identical
 * persistence/status wiring. Only the prompt/help/label *content* differs —
 * that stays in each module. This file owns the generic level resolution and
 * the extension factory both call.
 */

import { showTransientError } from "@xynogen/pix-pretty/transient-error";
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@xynogen/pix-runtime/host";
import { loadOptValue, saveOptValue } from "./persist.ts";
import type { OptimizerHandle, OptimizerStatus, OptimizerTool } from "./status.ts";

/**
 * Resolve a raw command arg to a level, or null if unrecognised.
 * Handles stop aliases (stop/quit → "off"), numeric shortcuts, and level names.
 */
export function resolveLevel<L extends string>(
	arg: string,
	levels: readonly L[],
	levelNumbers: Record<string, L>,
	stopAliases: ReadonlySet<string>,
): L | null {
	const a = arg.trim().toLowerCase();
	if (stopAliases.has(a)) return "off" as L;
	if (levelNumbers[a]) return levelNumbers[a];
	if (levels.includes(a as L)) return a as L;
	return null;
}

export interface ModeConfig<L extends string> {
	/** Status-registry key + persistence key + `${name}-level` custom entry. */
	name: OptimizerTool;
	/** One-line overlay summary. */
	help: string;
	/** Cyclable values in display order. */
	levels: readonly L[];
	/** Build the system-prompt fragment for a level ("" when off). */
	buildPrompt(level: L): string;
	/** Resolve an overlay/command value to a level (each module supplies its enum). */
	resolve(value: string): L | null;
	/** Notification shown after a successful change. */
	notify(level: L): string;
}

/**
 * Build the shared extension: prompt injection + session restore + status +
 * overlay handle. Identical across every prompt-mode tool.
 */
export function createMode<L extends string>(
	pi: ExtensionAPI,
	status: OptimizerStatus,
	config: ModeConfig<L>,
): OptimizerHandle {
	const { name, levels, buildPrompt } = config;
	const customType = `${name}-level`;
	let level = "off" as L;

	function syncStatus(ctx: Pick<ExtensionContext, "ui">) {
		status.set(name, level !== "off", ctx);
	}

	pi.on("before_agent_start", async (event, _ctx) => {
		const prompt = buildPrompt(level);
		if (!prompt) return undefined;
		const existing = event.systemPrompt ?? "";
		return { systemPrompt: `${prompt}\n\n${existing}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		// Session log first (survives in-session branch nav), then disk (survives
		// a full quit/restart). Disk wins when present.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === customType) {
				level = ((entry.data as { level: L })?.level ?? level) as L;
			}
		}
		const saved = loadOptValue(name);
		if (levels.includes(saved as L)) level = saved as L;
		syncStatus(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => syncStatus(ctx));
	pi.on("agent_end", async (_event, ctx) => syncStatus(ctx));
	pi.on("session_shutdown", async () => {});

	async function run(value: string, ctx: ExtensionCommandContext): Promise<void> {
		const resolved = config.resolve(value);
		if (resolved === null) return;
		level = resolved;

		pi.appendEntry(customType, { level });
		try {
			await saveOptValue(name, level);
		} catch (error) {
			const detail = getErrorMessage(error);
			showTransientError(ctx.ui, `optimizer: failed to save ${name}: ${detail}`);
		}
		syncStatus(ctx);

		ctx.ui.notify(config.notify(level), "info");
	}

	return {
		name,
		help: config.help,
		values: levels,
		current: () => level,
		run,
	};
}
