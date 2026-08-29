/**
 * Footer extension — pure-prompt style.
 *
 * Layout:
 *   [MODE] | ~/cwd (branch *±⇡n⇣n) | ⇡in ⇣out [Rcache] [ctx%/ctxk] [$cost] | model [· thinking] [· ctxK · $in/$out] [| status…] [| N t/s]
 *
 * - Branch shown with zsh-style dirty/ahead/behind markers.
 * - TPS: live during stream, holds 5s after turn ends, then clears.
 * - Model spec (ctx · cost) sourced from ~/.cache/pi/models-dev.json.
 * - Extension statuses surfaced via footerData.getExtensionStatuses();
 *   "plan" is rendered as the leftmost segment, others appended after model.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ModelsDevModel } from "@xynogen/pix-data";
import { benchScoreColor, lookupBenchmark, lookupModelsDev } from "@xynogen/pix-data";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { fmtTokenCount } from "@xynogen/pix-pretty/widget-format";

// ─── Pure formatting helpers ─────────────────────────────────────────

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type Theme = {
	fg(color: string, text: string): string;
	getThinkingBorderColor(level: ThinkingLevel): (text: string) => string;
};

const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function renderThinkingLevel(theme: Theme, level: string, text: string): string {
	if (!THINKING_LEVELS.has(level)) return theme.fg("dim", text);
	return theme.getThinkingBorderColor(level as ThinkingLevel)(text);
}

const execFileAsync = promisify(execFile);
const GIT_POLL_MS = 2_000;

const shortCwd = (cwd: string): string => {
	const base = cwd.split("/").filter(Boolean).pop();
	return base ?? cwd;
};

function fmtCost(entry: ModelsDevModel | undefined): string {
	const costIn = entry?.cost?.input ?? 0;
	const costOut = entry?.cost?.output ?? 0;
	if (costIn === 0 && costOut === 0) return "free";
	const fmt = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(2).replace(/\.?0+$/, ""));
	return `$ ${fmt(costIn)}/${fmt(costOut)}`;
}

// ────────────────────────────────────────────────────────────────────

interface GitStatus {
	dirty: boolean;
	staged: number;
	untracked: number;
	unstaged: number;
	ahead: number;
	behind: number;
}

async function getGitStatus(cwd: string): Promise<GitStatus | null> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
			{ cwd, timeout: 2_000, maxBuffer: 1024 * 1024 },
		);
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
	} catch {
		return null;
	}
}

// ─── Footer segment builders ─────────────────────────────────────────

interface SessionTotals {
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}

function computeSessionTotals(entries: Iterable<unknown>): SessionTotals {
	let input = 0,
		output = 0,
		cacheRead = 0,
		cost = 0;
	for (const e of entries as Iterable<{
		type: string;
		message?: { role: string; usage?: AssistantMessage["usage"] };
	}>) {
		if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) {
			const u = e.message.usage;
			input += u.input;
			output += u.output;
			cacheRead += u.cacheRead;
			cost += u.cost.total;
		}
	}
	return { input, output, cacheRead, cost };
}

/** Tokens block (in/out + cache/cost). Always returns a string; caller decides visibility. */
function renderTokens(totals: SessionTotals, theme: Theme, faded = false): string {
	let s = `${icon("net.in")} ${fmtTokenCount(totals.input)} ${icon("net.out")} ${fmtTokenCount(totals.output)}`;
	if (totals.cost > 0) s += ` $${totals.cost.toFixed(3)}`;
	return theme.fg(faded ? "muted" : "dim", s);
}

/** Context usage block: "used/total (pct%)". Always shown when available. */
function renderCtxUsage(
	usage: { percent?: number | null; contextWindow?: number } | undefined,
	theme: Theme,
): string {
	if (usage?.percent == null || !usage?.contextWindow) return "";
	const pct = Math.round(usage.percent);
	const used = Math.round((usage.percent / 100) * usage.contextWindow);
	const pctColor = pct >= 80 ? "error" : pct >= 50 ? "warning" : "success";
	return (
		theme.fg("muted", `${icon("tokens")}  `) +
		theme.fg("success", fmtTokenCount(used)) +
		theme.fg("muted", `/${fmtTokenCount(usage.contextWindow)} `) +
		theme.fg(pctColor, `(${pct}%)`)
	);
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
	model: { id?: string; provider?: string; name?: string } | undefined,
	thinking: string,
	theme: Theme,
): string {
	const rawId = model?.id ?? "?";
	const id = rawId.replace(/^[a-z]+\//i, "");
	const provider = model?.provider ?? "";
	let out = theme.fg("muted", `${icon("model")}  `) + theme.fg("accent", id);
	const THINK_ABBR: Record<string, string> = {
		minimal: "min",
		low: "low",
		medium: "med",
		high: "high",
		xhigh: "xhigh",
		off: "off",
	};
	if (thinking) {
		const abbr = THINK_ABBR[thinking] ?? thinking.slice(0, 3);
		out += theme.fg("muted", " · ") + renderThinkingLevel(theme, thinking, abbr);
	}
	if (provider && id !== "?") {
		const dev = lookupModelsDev(provider, id);
		const costStr = fmtCost(dev);
		// color the $ and numbers green, separator muted
		out += theme.fg("muted", " · ") + theme.fg("success", costStr);
	}
	const bench = lookupBenchmark(id);
	if (bench) {
		const score = bench.overallScore ?? "?";
		const scoreColor = benchScoreColor(bench.overallScore);
		out += theme.fg("muted", " · ") + theme.fg(scoreColor, `${icon("score")}${score}`);
	}
	return out;
}

/** Strip ANSI to inspect raw text, keep original colored string for output. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Replace verbose status text with icon + value. */
export function compactStatus(key: string, value: string, theme: Theme): string {
	const raw = stripAnsi(value);
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
		modePart: mode ? `${mode}${sep}` : "",
		otherPart: others.length ? sep + others.join(sep) : "",
	};
}

// ─── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let liveTps: string | null = null;
	let tpsTimer: ReturnType<typeof setTimeout> | null = null;
	// Token visibility state machine: "on" → (4s) → "dim" → (4s) → "off".
	type TokensState = "on" | "dim" | "off";
	let tokensState: TokensState = "off";
	let tokensTimer: ReturnType<typeof setTimeout> | null = null;
	let requestRender: (() => void) | null = null;

	const clearTimer = (t: ReturnType<typeof setTimeout> | null) => {
		if (t) clearTimeout(t);
	};

	let gitStatus: GitStatus | null = null;
	let gitTimer: ReturnType<typeof setInterval> | null = null;
	let currentCwd = "";

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
		if (total <= 0 || earliest === Infinity) return;
		const elapsed = (Date.now() - earliest) / 1000;
		if (elapsed < 0.1) return;
		const next = `${Math.round(total / elapsed)} t/s`;
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
	});

	const scheduleTpsClear = () => {
		if (tpsTimer) clearTimeout(tpsTimer);
		tpsTimer = setTimeout(() => {
			liveTps = null;
			tpsTimer = null;
			requestRender?.();
		}, 4_000);
	};

	const scheduleTokensDecay = () => {
		clearTimer(tokensTimer);
		tokensTimer = setTimeout(() => {
			tokensState = "dim";
			requestRender?.();
			tokensTimer = setTimeout(() => {
				tokensState = "off";
				tokensTimer = null;
				requestRender?.();
			}, 4_000);
		}, 4_000);
	};

	pi.on("agent_end", () => {
		stopTpsTicker();
		activeStreams.clear();
		scheduleTpsClear();
		scheduleTokensDecay();
	});

	// ── Git status polling ───────────────────────────────────────

	const refreshGit = async (cwd: string) => {
		const next = await getGitStatus(cwd);
		const changed = JSON.stringify(next) !== JSON.stringify(gitStatus);
		gitStatus = next;
		if (changed) requestRender?.();
	};

	pi.on("tool_execution_end", async (_event, ctx) => {
		await refreshGit(ctx.cwd);
	});

	// ── Footer registration ──────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
		void refreshGit(currentCwd);
		if (gitTimer) clearInterval(gitTimer);
		gitTimer = setInterval(() => {
			// ponytail: currentCwd avoids capturing stale ctx after session replacement
			if (currentCwd) void refreshGit(currentCwd);
		}, GIT_POLL_MS);

		ctx.ui.setFooter((tui, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
			requestRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => {
				void refreshGit(ctx.cwd);
				tui.requestRender();
			});

			return {
				dispose() {
					unsub();
					requestRender = null;
				},
				invalidate() {},
				render(width: number): string[] {
					const sep = theme.fg("muted", " | ");

					const totals = computeSessionTotals(ctx.sessionManager.getBranch());
					const tokens =
						tokensState === "off" ? "" : renderTokens(totals, theme, tokensState === "dim");
					const ctxUsage = renderCtxUsage(ctx.getContextUsage?.(), theme);
					const model = renderModel(ctx.model, pi.getThinkingLevel?.() ?? "", theme);
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

					const loc =
						theme.fg("muted", `${icon("cwd")}  `) +
						theme.fg("accent", shortCwd(ctx.cwd)) +
						branchSeg;
					const markersPart = markersSeg ? sep + markersSeg : "";
					const tpsPart = liveTps ? sep + theme.fg("accent", liveTps) : "";

					const tokensPart = tokens ? sep + tokens : "";
					const ctxPart = ctxUsage ? sep + ctxUsage : "";
					const line = `${modePart}${loc}${markersPart}${ctxPart}${sep}${model}${otherPart}${tokensPart}${tpsPart}`;
					return [truncateToWidth(line, width)];
				},
			};
		});
	});

	pi.on("session_shutdown", () => {
		if (gitTimer) {
			clearInterval(gitTimer);
			gitTimer = null;
		}
		if (tpsTimer) {
			clearTimeout(tpsTimer);
			tpsTimer = null;
		}
		clearTimer(tokensTimer);
		tokensTimer = null;
		stopTpsTicker();
	});
}
