/**
 * Footer extension — pure-prompt style.
 *
 * Layout:
 *   [MODE] │ ~/cwd (branch *±⇡n⇣n) │ model · thinking [used/total · pct%]        statuses · tokens · TPS │ cpu ⋮ gpu ⋮ ram │ clock
 *   (right block is flush right when it fits; otherwise one joined line)
 *
 * - Branch shown with zsh-style dirty/ahead/behind markers.
 * - TPS and tokens: live during stream, dim together after 4s, clear together after 8s.
 * - Model spec (ctx · cost) sourced from ~/.cache/pi/models-dev.json.
 * - Extension statuses surfaced via footerData.getExtensionStatuses();
 *   "plan" is rendered as the leftmost segment, others in the right-side activity group.
 */

import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import {
	type mixColors,
	sliceByColumn,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { benchScoreColor, lookupBenchmark, resolveModelsDev } from "@xynogen/pix-data";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { fadePaint, fadeText } from "@xynogen/pix-pretty/text";
import { warnBinaryMissing } from "@xynogen/pix-pretty/tool-status";
import { fmtTokenCount } from "@xynogen/pix-pretty/widget-format";
import { config, onConfigChange } from "@xynogen/pix-runtime/config";
import { runGit } from "@xynogen/pix-runtime/os";
import { prettySection } from "@xynogen/pix-runtime/sections";
import { readSystemStats, type SystemStats } from "@xynogen/pix-runtime/sysstat";

// ─── Pure formatting helpers ─────────────────────────────────────────

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type Theme = {
	fg(color: string, text: string): string;
	getThinkingBorderColor(level: ThinkingLevel): (text: string) => string;
	colors?: {
		dim: Parameters<typeof mixColors>[0];
		customMessageBg: Parameters<typeof mixColors>[1];
	};
	style?: (text: string, style: { fg: ReturnType<typeof mixColors> }) => string;
};

const THINKING_LEVELS = new Set<string>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export function renderThinkingLevel(theme: Theme, level: string, text: string): string {
	if (!THINKING_LEVELS.has(level)) return theme.fg("dim", text);
	return theme.getThinkingBorderColor(level as ThinkingLevel)(text);
}

const GIT_POLL_MS = 2_000;
const FOOTER_PAD = 1;

// basename splits on \ too on Windows. A root ("/", "C:\\") has no basename, so show it whole.
const shortCwd = (cwd: string): string => basename(cwd) || cwd;

// ────────────────────────────────────────────────────────────────────

interface GitStatus {
	dirty: boolean;
	staged: number;
	untracked: number;
	unstaged: number;
	ahead: number;
	behind: number;
}

/** Parse `git status`; null outside a repo. `onMissing` gets a BinaryMissingError once git is absent. */
async function getGitStatus(
	cwd: string,
	onMissing?: (err: unknown) => void,
): Promise<GitStatus | null> {
	try {
		const stdout = await runGit(
			["status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
			{ cwd, timeoutMs: 2_000, maxBuffer: 1024 * 1024 },
		);
		if (stdout === null) return null;
		let staged = 0,
			unstaged = 0,
			untracked = 0,
			ahead = 0,
			behind = 0;
		for (const line of stdout.split("\n")) {
			if (!line) continue;
			if (line.startsWith("## ")) {
				const m = line.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
				if (m) {
					if (m[1]) ahead = parseInt(m[1], 10);
					if (m[2]) behind = parseInt(m[2], 10);
					if (m[3]) behind = parseInt(m[3], 10);
				}
				continue;
			}
			if (line.startsWith("??")) {
				untracked += 1;
				continue;
			}
			const idx = line[0],
				wt = line[1];
			if (idx && idx !== " " && idx !== "?") staged += 1;
			if (wt && wt !== " " && wt !== "?") unstaged += 1;
		}
		return {
			dirty: unstaged + untracked > 0,
			staged,
			untracked,
			unstaged,
			ahead,
			behind,
		};
	} catch (err) {
		onMissing?.(err);
		return null;
	}
}

// ─── Footer segment builders ─────────────────────────────────────────

interface SessionTotals {
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
	/** Every message cost is the provider-billed total, not a catalog estimate. */
	billed: boolean;
}

export function computeSessionTotals(
	entries: Iterable<unknown>,
	resolvePrice = (provider: string, id: string) => resolveModelsDev(provider, id),
): SessionTotals {
	let input = 0,
		output = 0,
		cacheRead = 0,
		cost = 0,
		billed = true;
	for (const e of entries as Iterable<{
		type: string;
		message?: Pick<AssistantMessage, "role" | "usage" | "provider" | "model">;
	}>) {
		if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) {
			const u = e.message.usage;
			input += u.input;
			output += u.output;
			cacheRead += u.cacheRead;
			let messageCost = u.cost.total;
			if (
				!u.cost.totalFromProvider &&
				!(messageCost > 0) &&
				e.message.provider &&
				e.message.model
			) {
				const price = resolvePrice(e.message.provider, e.message.model)?.cost;
				if (price) {
					messageCost =
						(u.input * (price.input ?? 0) +
							u.output * (price.output ?? 0) +
							u.cacheRead * (price.cache_read ?? price.input ?? 0) +
							(u.cacheWrite ?? 0) * (price.cache_write ?? price.input ?? 0)) /
						1_000_000;
				}
			}
			cost += messageCost;
			// A zero-cost message is exact either way; only a priced estimate makes the total approximate.
			if (messageCost > 0 && !u.cost.totalFromProvider) billed = false;
		}
	}
	return { input, output, cacheRead, cost, billed };
}

/**
 * Live tokens-per-second, or null when the window is too short to trust.
 *
 * usage.output includes reasoning tokens (a subset of output). They land as one
 * lump early in the stream, so over a sub-second window they give a wild spike
 * (e.g. 800 tokens / 0.1s = 8000 t/s). The 1s floor amortizes that lump.
 */
export function computeTps(totalOutput: number, elapsedSec: number): number | null {
	if (totalOutput <= 0 || elapsedSec < 1) return null;
	return Math.round(totalOutput / elapsedSec);
}

/** Session tokens and spend in USD; `~` marks catalog estimates rather than provider billing. */
export function renderTokens(
	totals: SessionTotals,
	theme: Theme,
	faded: boolean,
	parts: typeof prettySection.defaults.footer,
): string {
	let s = parts.tokens
		? `${icon("net.in")} ${fmtTokenCount(totals.input)} ${icon("net.out")} ${fmtTokenCount(totals.output)}`
		: "";
	if (parts.cost && totals.cost > 0)
		s += `${s ? " · " : ""}$${totals.billed ? "" : "~"}${totals.cost.toFixed(3)}`;
	return s ? theme.fg(faded ? "muted" : "dim", s) : "";
}

/** Bracketed model context: "[used/total · pct%]". */
function renderCtxUsage(
	usage: { percent?: number | null; contextWindow?: number } | undefined,
	theme: Theme,
): string {
	if (usage?.percent == null || !usage?.contextWindow) return "";
	const pct = Math.round(usage.percent);
	const used = Math.round((usage.percent / 100) * usage.contextWindow);
	const pctColor = pct >= 80 ? "error" : pct >= 50 ? "warning" : "success";
	return (
		theme.fg("muted", "[") +
		theme.fg("success", fmtTokenCount(used)) +
		theme.fg("muted", `/${fmtTokenCount(usage.contextWindow)} · `) +
		theme.fg(pctColor, `${pct}%`) +
		theme.fg("muted", "]")
	);
}

type SysIcon = "sys.cpu" | "sys.gpu" | "sys.ram";

/** CPU usage + temperature ⋮ GPU usage + temperature ⋮ RAM usage. */
export function renderSystem(stats: SystemStats, theme: Theme): string {
	const value = (n: number | undefined, unit: string, warn: number, err: number) =>
		n === undefined
			? theme.fg("muted", "—")
			: theme.fg(n >= err ? "error" : n >= warn ? "warning" : "dim", `${n}${unit}`);
	const group = (key: SysIcon, usage: number | undefined, temp?: number) =>
		theme.fg("muted", `${icon(key)} `) +
		value(usage, "%", key === "sys.ram" ? 80 : 70, 90) +
		(key === "sys.ram" ? "" : ` ${value(temp, "°C", 75, 90)}`);
	return [
		group("sys.cpu", stats.cpu, stats.cpuTemp),
		group("sys.gpu", stats.gpu, stats.gpuTemp),
		group("sys.ram", stats.ram),
	].join(theme.fg("muted", " ⋮ "));
}

/** Local wall clock, "HH:MM". */
export function renderClock(now: Date, theme: Theme): string {
	const hhmm = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	return theme.fg("muted", `${icon("clock")} `) + theme.fg("dim", hhmm);
}

/** Branch + dirty/ahead/behind markers. */
function renderBranch(
	branch: string | null,
	gs: GitStatus | null,
	theme: Theme,
): { branchSeg: string; markersSeg: string } {
	if (!branch) return { branchSeg: "", markersSeg: "" };
	const dirty = gs?.dirty ?? false;
	const branchSeg = ` ${theme.fg("dim", branch) + (dirty ? theme.fg("error", "*") : "")}`;
	const markers: string[] = [];
	if (gs) {
		if (gs.staged > 0) markers.push(theme.fg("success", `+${gs.staged}`));
		if (gs.unstaged > 0) markers.push(theme.fg("error", `${icon("git.unstaged")}${gs.unstaged}`));
		if (gs.untracked > 0) markers.push(theme.fg("warning", `?${gs.untracked}`));
		if (gs.ahead > 0) markers.push(theme.fg("accent", `${icon("git.ahead")}${gs.ahead}`));
		if (gs.behind > 0) markers.push(theme.fg("accent", `${icon("git.behind")}${gs.behind}`));
	}
	return { branchSeg, markersSeg: markers.join(" ") };
}

/** "<modelId> [· thinking] [· ctxK · $in/$out]" */
function renderModel(
	model:
		| {
				id?: string;
				provider?: string;
				name?: string;
				contextWindow?: number;
				maxTokens?: number;
				cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
		  }
		| undefined,
	thinking: string,
	theme: Theme,
	parts: typeof prettySection.defaults.footer,
	context = "",
): string {
	const rawId = model?.id ?? "?";
	const id = rawId.replace(/^[a-z]+\//i, "");
	let out = parts.model ? theme.fg("muted", `${icon("model")}  `) + theme.fg("accent", id) : "";
	const separator = () => (out ? theme.fg("muted", " · ") : "");
	const THINK_ABBR: Record<string, string> = {
		minimal: "min",
		low: "low",
		medium: "med",
		high: "high",
		xhigh: "xhigh",
		off: "off",
	};
	if (parts.thinking && thinking) {
		const abbr = THINK_ABBR[thinking] ?? thinking.slice(0, 3);
		out += separator() + renderThinkingLevel(theme, thinking, abbr);
	}
	if (context) out += (out ? " " : "") + context;
	const bench = lookupBenchmark(id);
	if (parts.score && bench) {
		const score = bench.overallScore ?? "?";
		const scoreColor = benchScoreColor(bench.overallScore);
		out += separator() + theme.fg(scoreColor, `${icon("score")}${score}`);
	}
	return out;
}

/** Replace verbose status text with icon + value. */
export function compactStatus(key: string, value: string, theme: Theme): string {
	// Inspect the raw text, keep the colored string for output.
	const raw = stripVTControlCharacters(value);
	switch (key) {
		case "pi-lens-lsp": {
			const legacyCount = raw.match(/LSP Active \((\d+)\)/)?.[1];
			const activeList = raw.match(/LSP Active:\s*([^·]+)/)?.[1];
			const failedList = raw.match(/LSP Failed:\s*([^·]+)/)?.[1];
			const count = (list: string | undefined) =>
				list ? list.split(",").filter((id) => id.trim().length > 0).length : 0;
			const activeCount = legacyCount ? Number(legacyCount) : count(activeList);
			const failedCount = count(failedList);
			if (activeCount > 0)
				return theme.fg(
					"success",
					`${icon("lsp")}  ${activeCount}${failedCount > 0 ? ` !${failedCount}` : ""}`,
				);
			if (failedCount > 0) return theme.fg("error", `${icon("lsp")}  !${failedCount}`);
			if (/LSP Inactive/.test(raw)) return theme.fg("muted", `${icon("lsp")}  off`);
			return value;
		}
		case "mcp": {
			const m = raw.match(/(\d+)\/(\d+)\s+servers/);
			if (m) return theme.fg("dim", `${icon("mcp")} ${m[1]}/${m[2]}`);
			return value;
		}
		case "caveman": {
			const m = raw.match(/caveman level:\s*(\S+)/);
			if (m) return theme.fg("dim", `🪨 ${m[1]}`);
			return value;
		}
		default:
			return value;
	}
}

/** Pull mode out of extension statuses; return (modePart, otherParts joined). */
function renderStatuses(
	statuses: ReadonlyMap<string, string>,
	sep: string,
	theme: Theme,
): { modePart: string; otherPart: string } {
	const mode = statuses.get("plan") ?? statuses.get("phase");
	const ORDER = ["mcp", "pi-lens-lsp", "caveman"];
	const seen = new Set<string>(["plan", "phase"]);
	const others: string[] = [];
	for (const k of ORDER) {
		const v = statuses.get(k);
		seen.add(k);
		if (!v) continue;
		others.push(compactStatus(k, v, theme));
	}
	for (const [k, v] of statuses) {
		if (seen.has(k) || !v) continue;
		others.push(compactStatus(k, v, theme));
	}
	return {
		modePart: mode ?? "",
		otherPart: others.join(sep),
	};
}

// ─── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let liveTps: string | null = null;
	// TPS and tokens share visibility: "on" → (4s) → "dim" → (4s) → "off".
	type TokensState = "on" | "dim" | "off";
	let tokensState: TokensState = "off";
	let tokensTimer: ReturnType<typeof setTimeout> | null = null;
	let requestRender: (() => void) | null = null;
	let totals = computeSessionTotals([]);
	let resolvePrice: Parameters<typeof computeSessionTotals>[1];
	const prices = new Map<string, ReturnType<typeof resolveModelsDev>>();

	const clearTimer = (t: ReturnType<typeof setTimeout> | null) => {
		if (t) clearTimeout(t);
	};

	let gitStatus: GitStatus | null = null;
	let gitTimer: ReturnType<typeof setInterval> | null = null;
	let currentCwd = "";
	let sysStats: SystemStats = {};
	let systemPending = false;
	let nextSystemPoll = 0;
	const sampleSystem = () => {
		if (systemPending || Date.now() < nextSystemPoll) return;
		systemPending = true;
		nextSystemPoll = Date.now() + 5_000;
		void readSystemStats()
			.then((stats) => {
				sysStats = stats;
				requestRender?.();
			})
			.catch(() => {
				sysStats = {};
			})
			.finally(() => {
				systemPending = false;
			});
	};

	// ── TPS tracking ──────────────────────────────────────────────

	interface StreamState {
		start: number;
		output: number;
	}
	const activeStreams = new Map<string, StreamState>();
	let tpsTicker: ReturnType<typeof setInterval> | null = null;

	const recomputeTps = () => {
		let total = 0;
		let earliest = Infinity;
		for (const s of activeStreams.values()) {
			total += s.output;
			if (s.start < earliest) earliest = s.start;
		}
		if (earliest === Infinity) return;
		const rate = computeTps(total, (Date.now() - earliest) / 1000);
		if (rate === null) return;
		const next = `${rate} t/s`;
		if (next !== liveTps) {
			liveTps = next;
			requestRender?.();
		}
	};

	const startTpsTicker = () => {
		if (!tpsTicker) tpsTicker = setInterval(recomputeTps, 100);
	};
	const stopTpsTicker = () => {
		if (tpsTicker) {
			clearInterval(tpsTicker);
			tpsTicker = null;
		}
	};

	// AssistantMessage.id is not in the published d.ts but exists at runtime;
	// upstream type bug, hence the casts in this section.
	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		type RuntimeMsg = typeof event.message & {
			id: string;
			usage?: { output?: number };
		};
		// SAFETY: Assistant messages expose stable runtime id/usage fields missing from published types.
		const msg = event.message as unknown as RuntimeMsg;
		if (activeStreams.size === 0) liveTps = null;
		activeStreams.set(msg.id, {
			start: Date.now(),
			output: 0,
		});
		startTpsTicker();
		clearTimer(tokensTimer);
		tokensTimer = null;
		if (tokensState !== "on") {
			tokensState = "on";
			requestRender?.();
		}
	});

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		type RuntimeMsg = typeof event.message & {
			id: string;
			usage?: { output?: number };
		};
		// SAFETY: Assistant messages expose stable runtime id/usage fields missing from published types.
		const msg = event.message as unknown as RuntimeMsg;
		const id = msg.id;
		const s = activeStreams.get(id);
		if (!s) return;
		const ame = event.assistantMessageEvent as AssistantMessageEvent & {
			partial?: { usage?: { output?: number } };
		};
		const out = ame.partial?.usage?.output ?? msg.usage?.output ?? 0;
		if (out > s.output) s.output = out;
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		type RuntimeMsg = typeof event.message & {
			id: string;
			usage?: { output?: number };
		};
		// SAFETY: Assistant messages expose stable runtime id/usage fields missing from published types.
		const msg = event.message as unknown as RuntimeMsg;
		const id = msg.id;
		const s = activeStreams.get(id);
		const finalOut = msg.usage?.output ?? 0;
		if (s && finalOut > s.output) s.output = finalOut;
		recomputeTps();
		activeStreams.delete(id);
		if (activeStreams.size === 0) stopTpsTicker();
		if (typeof event.message.usage?.input === "number") {
			const delta = computeSessionTotals(
				[{ type: "message", message: event.message }],
				resolvePrice,
			);
			totals.input += delta.input;
			totals.output += delta.output;
			totals.cacheRead += delta.cacheRead;
			totals.cost += delta.cost;
			totals.billed &&= delta.billed;
			requestRender?.();
		}
	});

	const scheduleTokensDecay = () => {
		clearTimer(tokensTimer);
		tokensTimer = setTimeout(() => {
			tokensState = "dim";
			requestRender?.();
			tokensTimer = setTimeout(() => {
				tokensState = "off";
				liveTps = null;
				tokensTimer = null;
				requestRender?.();
			}, 4_000);
		}, 4_000);
	};

	pi.on("agent_end", () => {
		stopTpsTicker();
		activeStreams.clear();
		scheduleTokensDecay();
	});

	// ── Git status polling ───────────────────────────────────────

	let warnUi: Parameters<typeof warnBinaryMissing>[0];
	const refreshGit = async (cwd: string) => {
		const next = await getGitStatus(cwd, (err) => warnBinaryMissing(warnUi, err));
		const changed = JSON.stringify(next) !== JSON.stringify(gitStatus);
		gitStatus = next;
		if (changed) requestRender?.();
	};

	pi.on("tool_execution_end", async (_event, ctx) => {
		await refreshGit(ctx.cwd);
	});

	// ── Footer registration ──────────────────────────────────────

	pi.on("session_tree", (_event, ctx) => {
		totals = computeSessionTotals(ctx.sessionManager.getBranch(), resolvePrice);
		requestRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
		warnUi = ctx.ui;
		prices.clear();
		resolvePrice = (provider, id) => {
			const key = `${provider}/${id}`;
			if (!prices.has(key))
				prices.set(key, resolveModelsDev(provider, id, ctx.modelRegistry?.find(provider, id)));
			return prices.get(key);
		};
		totals = computeSessionTotals(ctx.sessionManager.getBranch(), resolvePrice);
		void refreshGit(currentCwd);
		if (gitTimer) clearInterval(gitTimer);
		sampleSystem();
		gitTimer = setInterval(() => {
			// ponytail: currentCwd avoids capturing stale ctx after session replacement
			if (currentCwd) void refreshGit(currentCwd);
			// Same 2s tick refreshes host stats and the clock.
			sampleSystem();
			requestRender?.();
		}, GIT_POLL_MS);

		ctx.ui.setFooter((tui, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
			requestRender = () => tui.requestRender();
			const unsubConfig = onConfigChange(() => tui.requestRender(), { paths: ["pretty.footer.*"] });
			const unsub = footerData.onBranchChange(() => {
				void refreshGit(ctx.cwd);
				tui.requestRender();
			});

			const footer = {
				dispose() {
					unsub();
					unsubConfig();
					requestRender = null;
				},
				invalidate() {},
				render(width: number): string[] {
					// One column of breathing room against the terminal edge on both sides.
					const pad = " ".repeat(FOOTER_PAD);
					return footer.row(Math.max(0, width - 2 * FOOTER_PAD)).map((line) => pad + line + pad);
				},
				row(width: number): string[] {
					const sep = theme.fg("muted", " │ ");

					// A version-skewed pix-runtime copy can own the globalThis singleton and
					// parse "pretty" without the footer key. Merge defaults so render never sees undefined.
					const parts = { ...prettySection.defaults.footer, ...config(prettySection).footer };
					const tokens =
						tokensState === "off"
							? ""
							: renderTokens(totals, theme, tokensState === "dim", { ...parts, cost: false });
					const spend = renderTokens(totals, theme, false, { ...parts, tokens: false });
					const model = renderModel(
						ctx.model,
						pi.getThinkingLevel?.() ?? "",
						theme,
						parts,
						parts.context ? renderCtxUsage(ctx.getContextUsage?.(), theme) : "",
					);
					const { branchSeg, markersSeg } = renderBranch(
						footerData.getGitBranch(),
						gitStatus,
						theme,
					);
					const { modePart, otherPart } = renderStatuses(
						footerData.getExtensionStatuses(),
						sep,
						theme,
					);

					const loc = parts.cwd
						? theme.fg("muted", `${icon("cwd")}  `) + theme.fg("accent", shortCwd(ctx.cwd))
						: "";
					const left = [
						parts.mode ? modePart : "",
						loc + (parts.git ? branchSeg : ""),
						parts.git ? markersSeg : "",
						model,
					]
						.filter(Boolean)
						.join(sep);
					const right = [
						[
							parts.tps && tokensState !== "off"
								? theme.fg(tokensState === "dim" ? "muted" : "dim", liveTps ?? "— t/s")
								: "",
							tokens,
							spend,
						]
							.filter(Boolean)
							.join(theme.fg("muted", " · ")),
						parts.statuses ? otherPart : "",
						parts.system ? renderSystem(sysStats, theme) : "",
						parts.clock ? renderClock(new Date(Date.now()), theme) : "",
					]
						.filter(Boolean)
						.join(sep);
					const line = [left, right].filter(Boolean).join(sep);
					if (!line || width < 1) return [];
					const gap = width - visibleWidth(left) - visibleWidth(right);
					if (left && right && gap >= 3) return [left + " ".repeat(gap) + right];
					if (parts.wrap) return wrapTextWithAnsi(line, width);
					if (visibleWidth(line) <= width) return [line];
					const head = sliceByColumn(line, 0, Math.max(0, width - 8), true);
					const start = visibleWidth(head);
					return [
						head +
							fadeText(
								sliceByColumn(line, start, visibleWidth(line) - start, true),
								width - start,
								fadePaint(theme),
							),
					];
				},
			};
			return footer;
		});
	});

	pi.on("session_shutdown", () => {
		if (gitTimer) {
			clearInterval(gitTimer);
			gitTimer = null;
		}
		clearTimer(tokensTimer);
		tokensTimer = null;
		stopTpsTicker();
	});
}
