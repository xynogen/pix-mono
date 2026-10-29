/**
 * Welcome extension — ASCII art banner + startup health checks.
 *
 * Renders a coloured π logo in the header on session start.
 * Runs checks in parallel while the banner is visible:
 *
 *   · PI version   — read installed version only
 *   · auth         — at least one provider configured in modelRegistry
 *   · models       — count of loaded models
 *   · tools        — count of active tools
 *   · skills       — count of loaded skills
 *   · gitignore    — offer once per repo to ignore Pi emissions (.pi/)
 *
 * Each check updates the banner live as results arrive.
 * Banner auto-dismisses on the first user turn (turn_start).
 *
 * Layout:
 *
 *   ██████╗ ██╗██╗  ██╗
 *   ██╔══██╗██║╚██╗██╔╝
 *   ██████╔╝██║ ╚███╔╝
 *   ██╔═══╝ ██║ ██╔██╗
 *   ██║     ██║██╔╝ ██╗
 *   ╚═╝     ╚═╝╚═╝  ╚═╝
 *
 *   ✓ PI      0.78.0
 *   ✓ Auth    connected
 *   ✓ Models  16 loaded
 *   ✓ Tools   24 loaded
 *   ✓ Skills  10 loaded
 *   ✓ Ignore  up to date
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { padIcon } from "@xynogen/pix-pretty/utils";
import { writeFileAtomicSync } from "@xynogen/pix-runtime/atomic-write";
import { runTool } from "@xynogen/pix-runtime/exec";
import { runGit } from "@xynogen/pix-runtime/os";
import { agentDir, homeDir } from "@xynogen/pix-runtime/paths";

// ─── Theme shim (same pattern as footer.ts) ───────────────────────────────────

export type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

// ─── ASCII logo ───────────────────────────────────────────────────────────────

export type Tag = "heading" | "model" | "cwd" | "ready" | "";

export const LOGO_ROWS: [string, Tag][] = [
	["██████╗ ██╗██╗  ██╗", ""],
	["██╔══██╗██║╚██╗██╔╝", "heading"],
	["██████╔╝██║ ╚███╔╝ ", ""],
	["██╔═══╝ ██║ ██╔██╗ ", "model"],
	["██║     ██║██╔╝ ██╗", "cwd"],
	["╚═╝     ╚═╝╚═╝  ╚═╝", "ready"],
];

// ─── Check result ─────────────────────────────────────────────────────────────

export type CheckStatus = "pending" | "ok" | "warn" | "error";

export interface CheckResult {
	label: string;
	status: CheckStatus;
	detail?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const shortCwd = (cwd: string, home?: string): string => {
	const h = home ?? homeDir();
	return h && cwd.startsWith(h) ? `~${cwd.slice(h.length)}` : cwd;
};

export const PI_IGNORE_RULES = [".pi/"];
const PI_IGNORE_SECTION_HEADER = "# Pix Agent";

// ─── Individual checks ────────────────────────────────────────────────────────

/** "<tool> missing · /pix → Binaries" for a BinaryMissingError, else undefined. */
function missingDetail(err: unknown): string | undefined {
	return err instanceof Error && err.name === "BinaryMissingError"
		? `${(err as Error & { tool?: string }).tool ?? "binary"} missing · /pix → Binaries`
		: undefined;
}

async function checkPiVersion(): Promise<CheckResult> {
	try {
		const localRes = await runTool("pi", ["--version"], { timeoutMs: 2_000 });
		const local = (localRes.stdout.trim() || localRes.stderr.trim()).replace(/^v/, "");
		return { label: "PI", status: "ok", detail: local || "installed" };
	} catch (err) {
		return { label: "PI", status: "warn", detail: missingDetail(err) ?? "version unavailable" };
	}
}

/**
 * Add `missing` rules without touching any existing line: insert them right
 * after an existing `# Pix Agent` header, else append a new block. Keeps the
 * file's line ending (CRLF or LF).
 */
export function appendIgnoreRules(existing: string, missing: readonly string[]): string {
	const eol = existing.includes("\r\n") ? "\r\n" : "\n";
	const lines = existing.split(/\r?\n/);
	const header = lines.findIndex((line) => line.trim() === PI_IGNORE_SECTION_HEADER);
	if (header >= 0) {
		lines.splice(header + 1, 0, ...missing);
		return lines.join(eol);
	}
	const base = existing && !existing.endsWith("\n") ? `${existing}${eol}` : existing;
	const gap = base.trim() ? eol : "";
	return `${base}${gap}${[PI_IGNORE_SECTION_HEADER, ...missing].join(eol)}${eol}`;
}

// Repos where the user said no. A yes needs no record: the rules then exist.
function declinedFile(): string {
	return join(agentDir(), "pix-welcome.json");
}

function declinedRepos(): string[] {
	try {
		const data = JSON.parse(readFileSync(declinedFile(), "utf8")) as { ignoreDeclined?: unknown };
		return Array.isArray(data.ignoreDeclined)
			? data.ignoreDeclined.filter((r) => typeof r === "string")
			: [];
	} catch {
		return [];
	}
}

function rememberDecline(repoRoot: string): void {
	const ignoreDeclined = [...new Set([...declinedRepos(), repoRoot])];
	writeFileAtomicSync(declinedFile(), `${JSON.stringify({ ignoreDeclined }, null, 2)}\n`);
}

export type ConfirmFn = (title: string, message: string) => Promise<boolean>;

/**
 * Offer once per repo to add Pi's ignore rules. `confirm` is undefined without
 * a UI (print/RPC): then only report what is missing and never edit.
 */
export async function checkPiIgnore(cwd: string, confirm?: ConfirmFn): Promise<CheckResult> {
	try {
		// Find repo root — avoids creating .gitignore in a subfolder
		const root = await runGit(["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 2_000 });
		const repoRoot = root?.trim();
		if (!repoRoot) return { label: "Ignore", status: "ok", detail: "not git" };

		// Read .gitignore in-process — shelling out to grep/node was fragile
		// (CRLF, trailing whitespace, grep exit-code 2, or grep/node off PATH all
		// silently degraded to "missing", so the panel rewrote every session).
		const gitignorePath = `${repoRoot}/.gitignore`;
		const exists = existsSync(gitignorePath);
		const existing = exists ? readFileSync(gitignorePath, "utf8") : "";

		// Whitespace-tolerant whole-line match (handles CRLF + trailing spaces).
		const presentLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
		const missing = PI_IGNORE_RULES.filter((rule) => !presentLines.has(rule));

		if (missing.length === 0) {
			return { label: "Ignore", status: "ok", detail: "up to date" };
		}
		if (declinedRepos().includes(repoRoot)) {
			return { label: "Ignore", status: "ok", detail: "skipped (declined)" };
		}
		if (!confirm) {
			return { label: "Ignore", status: "warn", detail: `${missing.join(", ")} not ignored` };
		}

		const ok = await confirm(
			`Add ${missing.join(", ")} to .gitignore?`,
			`Pix keeps plans and caches in .pi/. This appends to ${gitignorePath}:\n\n${[PI_IGNORE_SECTION_HEADER, ...missing].join("\n")}\n\nAsked once per repo.`,
		);
		if (!ok) {
			rememberDecline(repoRoot);
			return { label: "Ignore", status: "ok", detail: "skipped (declined)" };
		}

		// Keep the user's permissions; the atomic helper defaults to 0o600.
		const mode = exists ? statSync(gitignorePath).mode & 0o777 : 0o644;
		writeFileAtomicSync(gitignorePath, appendIgnoreRules(existing, missing), mode);

		return {
			label: "Ignore",
			status: "ok",
			detail: `${missing.length} added`,
		};
	} catch (err) {
		return { label: "Ignore", status: "warn", detail: missingDetail(err) ?? "check failed" };
	}
}

interface SkillInfo {
	disableModelInvocation?: boolean;
}

/**
 * Discover all `skills/` directories from:
 *   1. The pi-agent npm extensions dir (walks one scope level deep)
 *   2. ~/.pi/agent/skills (user-level)
 *   3. Any extra dirs passed by the caller
 *
 * Mirrors how pi's resource-loader collects skillPaths from resources_discover.
 * Does NOT depend on before_agent_start — safe to call at session_start.
 */
export function discoverSkillDirs(extraDirs: string[] = []): string[] {
	const npmDir = join(agentDir(), "npm", "node_modules");
	const found: string[] = [];

	// Walk npm extensions dir: flat packages + scoped (@scope/pkg)
	if (existsSync(npmDir)) {
		try {
			for (const pkg of readdirSync(npmDir, { withFileTypes: true })) {
				if (!pkg.isDirectory() && !pkg.isSymbolicLink()) continue;
				if (pkg.name.startsWith("@")) {
					// scoped: walk one level deeper
					const scopeDir = join(npmDir, pkg.name);
					try {
						for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
							if (!sub.isDirectory() && !sub.isSymbolicLink()) continue;
							const skillsDir = join(scopeDir, sub.name, "skills");
							if (existsSync(skillsDir)) found.push(skillsDir);
						}
					} catch {
						/* skip */
					}
				} else {
					const skillsDir = join(npmDir, pkg.name, "skills");
					if (existsSync(skillsDir)) found.push(skillsDir);
				}
			}
		} catch {
			/* skip */
		}
	}

	// User-level skills dir
	const userSkills = join(agentDir(), "skills");
	if (existsSync(userSkills)) found.push(userSkills);

	found.push(...extraDirs);
	return found;
}

/**
 * Count skills in an explicit list of skill directories.
 * Deduplicates by resolved real path to avoid double-counting symlinked packages.
 */
export function countSkillsInDirs(dirs: string[]): number {
	let total = 0;
	const seen = new Set<string>();

	const add = (p: string) => {
		const real = (() => {
			try {
				return resolve(p);
			} catch {
				return p;
			}
		})();
		if (seen.has(real)) return;
		seen.add(real);
		total++;
	};

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					const skillMd = join(dir, entry.name, "SKILL.md");
					if (existsSync(skillMd)) add(skillMd);
				} else if (entry.isFile() && entry.name.endsWith(".md")) {
					add(join(dir, entry.name));
				}
			}
		} catch {
			/* skip */
		}
	}
	return total;
}

/** Count skills across all auto-discovered + extra dirs. */
export function countSkillsFromDirs(extraDirs: string[] = []): number {
	return countSkillsInDirs(discoverSkillDirs(extraDirs));
}

export function summariseSkills(skills: SkillInfo[]): CheckResult {
	const total = skills.length;
	if (total === 0) return { label: "Skills", status: "warn", detail: "none loaded" };
	const manual = skills.filter((s) => s.disableModelInvocation).length;
	const detail =
		manual === total
			? `${total} loaded (manual)`
			: manual > 0
				? `${total} loaded (+${manual} manual)`
				: `${total} loaded`;
	return { label: "Skills", status: "ok", detail };
}

interface ToolInfo {
	sourceInfo?: { source?: string };
}

/**
 * Summarise loaded tools. Counts everything in `getActiveTools()` and reports
 * the total as the detail line (`N loaded`).
 */
export function summariseTools(tools: ToolInfo[]): CheckResult {
	const total = tools.length;
	if (total === 0) {
		return { label: "Tools", status: "warn", detail: "none active" };
	}
	return { label: "Tools", status: "ok", detail: `${total} loaded` };
}

function checkTools(pi: { getActiveTools?: () => ToolInfo[] }): CheckResult {
	try {
		const tools = pi.getActiveTools?.() ?? [];
		return summariseTools(tools);
	} catch {
		return { label: "Tools", status: "warn", detail: "unavailable" };
	}
}

function checkAuth(ctx: {
	modelRegistry: { getAvailable(): unknown[] };
}): [CheckResult, CheckResult] {
	try {
		const models = ctx.modelRegistry.getAvailable();
		const count = models.length;
		if (count === 0) {
			return [
				{ label: "Auth", status: "warn", detail: "run /login" },
				{ label: "Models", status: "warn", detail: "0 loaded" },
			];
		}
		return [
			{ label: "Auth", status: "ok", detail: "connected" },
			{ label: "Models", status: "ok", detail: `${count} loaded` },
		];
	} catch {
		return [
			{ label: "Auth", status: "error", detail: "registry unavailable" },
			{ label: "Models", status: "error", detail: "unavailable" },
		];
	}
}

// ─── Render ───────────────────────────────────────────────────────────────────

export function statusIcon(theme: Theme, status: CheckStatus): string {
	switch (status) {
		case "pending":
			return theme.fg("muted", icon("status.pending"));
		case "ok":
			return theme.fg("success", icon("status.ok"));
		case "warn":
			return theme.fg("warning", icon("status.warn"));
		case "error":
			return theme.fg("error", icon("status.error"));
	}
}

export const LABEL_WIDTH = 6; // visual chars for label column

export function renderCheck(theme: Theme, c: CheckResult): string {
	const icon = statusIcon(theme, c.status);
	const labelColor = c.status === "error" ? "error" : c.status === "warn" ? "warning" : "dim";
	const label = theme.fg(labelColor, c.label.padEnd(LABEL_WIDTH));
	const detail = c.detail ? theme.fg("text", c.detail) : "";
	// padIcon normalizes 1-cell (✓/✗/○) vs 2-cell (⚠) markers to one column.
	return `${padIcon(icon)} ${label}  ${detail}`;
}

function buildLogoLines(theme: Theme, model: string, cwd: string): string[] {
	const pad = "   ";
	return LOGO_ROWS.map(([logo, tag]) => {
		const l = theme.fg("accent", logo);
		switch (tag) {
			case "heading":
				return `${pad}${l}  ${theme.fg("dim", "PIx")}`;
			case "model":
				return `${pad}${l}  ${theme.fg("muted", icon("model"))}  ${theme.fg("text", model)}`;
			case "cwd":
				return `${pad}${l}  ${theme.fg("muted", icon("folder"))}  ${theme.fg("text", cwd)}`;
			case "ready": {
				const mark = theme.fg("success", icon("ready"));
				const label = theme.bold(theme.fg("success", "ready"));
				return `${pad}${l}  ${mark}  ${label}`;
			}
			default:
				return `${pad}${l}`;
		}
	});
}

function buildCheckLines(theme: Theme, checks: CheckResult[]): string[] {
	if (checks.length === 0) return [];
	const pad = "   ";
	const lines: string[] = [""];
	for (const c of checks) {
		lines.push(`${pad}${renderCheck(theme, c)}`);
	}
	return lines;
}

/** Clamp one banner line to `width`, preserving ANSI. Empty lines pass through. */
function fitLine(line: string, width: number): string {
	if (!line) return line;
	return truncateToWidth(line, Math.max(0, width), "…");
}

/**
 * Full banner, every line clamped to `width`. A logo line wider than the
 * terminal would otherwise make Pi's TUI throw, so this is the safe entry point
 * the header render uses.
 */
export function renderWelcome(
	theme: Theme,
	model: string,
	cwd: string,
	checks: CheckResult[],
	width: number,
): string[] {
	const lines = [...buildLogoLines(theme, model, cwd), ...buildCheckLines(theme, checks), ""];
	return lines.map((line) => fitLine(line, width));
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let dismissed = false;
	let requestRender: (() => void) | null = null;
	let _updateSkills: ((r: CheckResult) => void) | null = null;

	const dismiss = () => {
		if (dismissed) return;
		dismissed = true;
		requestRender?.();
		requestRender = null;
	};

	pi.on("session_start", (event, ctx) => {
		// ponytail: /reload refreshes extensions, not the session; skip the second splash and checks.
		if (event.reason === "reload") return;
		dismissed = false;

		// cwd is static; model can change via /model so keep it mutable
		const modelId = ctx.model?.id ?? "—";
		const cwd = shortCwd(ctx.cwd);

		// Pending placeholders — one per check
		const CHECKS: CheckResult[] = [
			{ label: "PI", status: "pending" },
			{ label: "Auth", status: "pending" },
			{ label: "Models", status: "pending" },
			{ label: "Tools", status: "pending" },
			{ label: "Skills", status: "pending" },
			{ label: "Ignore", status: "pending" },
		];

		// Auth + Models checks are synchronous — fill immediately
		const [authResult, modelsResult] = checkAuth(ctx);
		CHECKS[1] = authResult;
		CHECKS[2] = modelsResult;

		// The header stays above chat notifications, unlike an editor widget.
		if (!ctx.ui.setHeader) return;
		ctx.ui.setHeader((tui: { requestRender(): void }, theme: Theme) => {
			requestRender = () => tui.requestRender();

			return {
				render: (width: number) => {
					// SAFETY: Host theme implements the smaller local foreground-only Theme contract.
					const t = theme as unknown as Theme;
					// Re-read modelId each render so /model changes show live.
					// Clamp to width so an over-wide logo line never crashes Pi's TUI.
					return dismissed ? [] : renderWelcome(t, modelId, cwd, CHECKS, width);
				},
				dispose() {
					requestRender = null;
				},
				invalidate() {},
			};
		});

		// Run async checks in parallel; each updates CHECKS and re-renders
		const update = (idx: number, result: CheckResult) => {
			if (dismissed) return;
			CHECKS[idx] = result;
			requestRender?.();
		};

		// Expose skills updater so the before_agent_start handler can refine the count.
		_updateSkills = (r: CheckResult) => update(4, r);

		void checkPiVersion().then((r) => update(0, r));
		const confirm: ConfirmFn | undefined = ctx.hasUI
			? (title, message) => ctx.ui.confirm(title, message)
			: undefined;
		void checkPiIgnore(ctx.cwd, confirm).then((r) => update(5, r));
		// auth already filled synchronously above; no async needed

		// Tools register during session_start (incl. other extensions); read on
		// next tick so dynamically registered tools are counted.
		// Skills: scan dirs immediately — no need to wait for before_agent_start.
		setTimeout(() => {
			// SAFETY: ExtensionAPI exposes getActiveTools at runtime before its published type does.
			update(3, checkTools(pi as unknown as { getActiveTools?: () => ToolInfo[] }));
			update(4, {
				label: "Skills",
				status: "ok",
				detail: `${countSkillsFromDirs()} loaded`,
			});
		}, 0);
	});

	// before_agent_start fires after resources_discover — use the authoritative
	// skills list from systemPromptOptions to refine the count, then dismiss.
	pi.on("before_agent_start", (event) => {
		const skills = event.systemPromptOptions?.skills ?? [];
		if (skills.length > 0) _updateSkills?.(summariseSkills(skills));
		dismiss();
	});

	pi.on("turn_start", () => {
		dismiss();
	});
	pi.on("session_shutdown", () => {
		dismiss();
	});
}
