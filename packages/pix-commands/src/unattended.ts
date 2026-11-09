/**
 * Session modes — /afk, /yolo, and /nuclear.
 */

import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lookupBenchmark } from "@xynogen/pix-data";
import { showOverlay } from "@xynogen/pix-pretty/gate-overlay";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	getUnattendedMode,
	hasYoloConsent,
	resetUnattendedState,
	setUnattendedMode,
	setYoloConsent,
	type UnattendedMode,
} from "@xynogen/pix-runtime";

/** Minimum model score allowed to hold YOLO. Below this, red+root auto-approve is off-limits. */
export const YOLO_MIN_SCORE = 75;

type StatusUI = {
	theme: { fg(color: "error", text: string): string };
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, kind?: string): void;
};
type ModelCtx = { model?: { id?: string } };

const STATUS_KEY = "unattended";

export { getUnattendedMode as getMode, setUnattendedMode as setMode };

function syncStatus(events: EventBus, ui: StatusUI): void {
	const labels: Record<UnattendedMode, string | undefined> = {
		yolo: `${icon("warn")} YOLO`,
		nuclear: `${icon("mode.nuclear")} NUCLEAR`,
		afk: `${icon("afk")} AFK`,
		off: undefined,
	};
	const label = labels[getUnattendedMode(events)];
	ui.setStatus(STATUS_KEY, label ? ui.theme.fg("error", label) : undefined);
}

/**
 * Blocking, session-scoped consent gate. The first `/yolo` enable of a session
 * shows a modal spelling out the damage risk and the no-liability disclaimer;
 * the user must explicitly accept before YOLO can arm. Consent does NOT persist
 * across sessions — a fresh session asks again (moral speed-bump, not a
 * once-and-forget click-through).
 */
export async function confirmYoloConsent(events: EventBus, ctx: ModelCtx): Promise<boolean> {
	if (hasYoloConsent(events)) return true;
	const ui = (ctx as { ui?: unknown }).ui as Parameters<typeof showOverlay>[0] | undefined;
	if (!ui) return false;
	const result = await showOverlay(ui, {
		mode: "confirm",
		accent: "error",
		icon: icon("warn"),
		title: "YOLO Mode — No Human Confirms Anything",
		body: [
			"Every gate auto-approves, including RED and root. Destructive,",
			"irreversible actions (data loss, wiped disks, force-push) can run",
			"and CANNOT be undone. Only the circuit breaker stays active.",
			"Watch the model closely — it can rationalize or downplay a risky",
			"action to get past its own self-justification. Do not trust the",
			"reasoning blindly.",
			"You accept all risk; AS IS, no liability (MIT).",
		],
		choices: [
			{ value: "no", label: "Cancel", description: "Keep approval prompts" },
			{
				value: "yes",
				label: "Accept all risk",
				description: "Enable YOLO this session",
			},
		],
	});
	const ok = result.action === "approved";
	if (ok) setYoloConsent(events, true);
	return ok;
}

/** Current model's benchmark score, or null when unknown/off-catalog. */
export function modelScore(ctx: ModelCtx): number | null {
	const id = (ctx.model?.id ?? "").replace(/^[a-z]+\//i, "");
	if (!id) return null;
	return lookupBenchmark(id)?.overallScore ?? null;
}

/**
 * Per-turn awareness banner. Injected via `before_agent_start` so the model is
 * told, every turn, that the human safety net is off and what it now owns.
 */
export function unattendedBanner(events: EventBus): string | undefined {
	const mode = getUnattendedMode(events);
	if (mode === "nuclear") {
		return [
			'<pix-unattended mode="nuclear">',
			"NUCLEAR MODE ACTIVE. Pix approval gates, shell SSH/sudo redirects, and the",
			"circuit breaker are disabled for this session. No human approval stops execution.",
			"This does not authorize unrelated actions or override system/OS restrictions.",
			"Authentication, input validation, cancellation, and SSH host-key verification remain active.",
			"Never expose passwords or secrets. Stay within the user's requested scope.",
			"</pix-unattended>",
		].join("\n");
	}
	if (mode === "yolo") {
		return [
			'<pix-unattended mode="yolo">',
			"YOLO MODE ACTIVE. Every permission gate — including RED/critical commands and",
			"root (sudo_run) — auto-approves with NO human confirming. The safety net is OFF:",
			"nothing will stop a destructive or irreversible action before it runs. You alone",
			"are accountable for the fallout.",
			"Before any red-tier or root action, first state in your reply: (1) why it is",
			"necessary, (2) its blast radius and worst-case fallout, (3) whether it is",
			"reversible. If you cannot justify it, do not run it. Always prefer the least",
			"destructive path that still does the job.",
			"</pix-unattended>",
		].join("\n");
	}
	if (mode === "afk") {
		return [
			'<pix-unattended mode="afk">',
			"AFK MODE ACTIVE. The user is away. Medium-risk (yellow) gates auto-approve; RED/",
			"critical commands and root (sudo_run) auto-DENY and will fail. No human will",
			"confirm anything this turn.",
			"Plan around the auto-deny: do not depend on a red or root step succeeding. State",
			"the intent and consequence of any gated action. When a denied step blocks",
			"progress, stop and summarize what needs the user.",
			"</pix-unattended>",
		].join("\n");
	}
	return undefined;
}

export default function registerUnattended(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		resetUnattendedState(pi.events);
		syncStatus(pi.events, ctx.ui);
	});

	// Every turn: prepend the awareness banner while a mode is active.
	pi.on("before_agent_start", (event) => {
		const banner = unattendedBanner(pi.events);
		if (!banner) return undefined;
		const existing = (event as { systemPrompt?: string }).systemPrompt ?? "";
		return { systemPrompt: `${banner}\n\n${existing}` };
	});

	pi.registerCommand("afk", {
		description: "Toggle AFK mode — yellow gates auto-allow; red and root auto-deny",
		handler: async (_args, ctx) => {
			const turningOn = getUnattendedMode(pi.events) !== "afk";
			setUnattendedMode(pi.events, turningOn ? "afk" : "off");
			syncStatus(pi.events, ctx.ui);
			ctx.ui.notify(
				turningOn
					? "AFK mode on — yellow gates auto-allow; red and root auto-deny."
					: "AFK mode off — approval prompts restored.",
				turningOn ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("yolo", {
		description: "Toggle YOLO mode — auto-approve everything including red and root",
		handler: async (_args, ctx) => {
			if (getUnattendedMode(pi.events) === "yolo") {
				setUnattendedMode(pi.events, "off");
				syncStatus(pi.events, ctx.ui);
				ctx.ui.notify("YOLO mode off — approval prompts restored.", "info");
				return;
			}
			const score = modelScore(ctx as ModelCtx);
			if (score === null) {
				ctx.ui.notify(
					`YOLO refused — cannot verify this model scores ≥ ${YOLO_MIN_SCORE}. ` +
						"Auto-approving red and root needs a benchmarked, capable model.",
					"error",
				);
				return;
			}
			if (score < YOLO_MIN_SCORE) {
				ctx.ui.notify(
					`YOLO refused — model score ${score} is below ${YOLO_MIN_SCORE}. ` +
						"Use a more capable model to auto-approve red and root actions.",
					"error",
				);
				return;
			}
			if (!(await confirmYoloConsent(pi.events, ctx as ModelCtx))) {
				ctx.ui.notify("YOLO cancelled — approval prompts remain in place.", "info");
				return;
			}
			setUnattendedMode(pi.events, "yolo");
			syncStatus(pi.events, ctx.ui);
			ctx.ui.notify(
				`YOLO mode on (model score ${score}) — every gate including red and root ` +
					"auto-approves. No human will stop a destructive action. You are accountable.",
				"warning",
			);
		},
	});

	pi.registerCommand("nuclear", {
		description: "Toggle session-only nuclear mode — disable all Pix approval gates",
		handler: async (_args, ctx) => {
			if (getUnattendedMode(pi.events) === "nuclear") {
				setUnattendedMode(pi.events, "off");
				syncStatus(pi.events, ctx.ui);
				ctx.ui.notify("Nuclear mode off — approval gates restored.", "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"Nuclear mode requires explicit confirmation in an interactive session.",
					"error",
				);
				return;
			}
			const result = await showOverlay(ctx.ui, {
				mode: "confirm",
				accent: "error",
				icon: icon("mode.nuclear"),
				title: "Nuclear Mode — Disable Pix Approval Gates",
				body: [
					"Command/path approval, SSH/sudo redirects, secret injection approval,",
					"and the circuit breaker will be disabled. Destructive actions can run",
					"without confirmation and may cause irreversible data loss.",
					"Authentication, secret protection, input validation, and SSH host-key checks remain.",
					"Only this session. /nuclear disables it; /new resets it.",
				],
				choices: [
					{ value: "no", label: "Cancel", description: "Keep current protections" },
					{
						value: "yes",
						label: "Accept all risk",
						description: "Disable Pix approval gates this session",
					},
				],
			});
			if (result.action !== "approved") return;
			setUnattendedMode(pi.events, "nuclear");
			syncStatus(pi.events, ctx.ui);
			ctx.ui.notify("NUCLEAR — Pix approval gates disabled for this session.", "warning");
		},
	});
}
