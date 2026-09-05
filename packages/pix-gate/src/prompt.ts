/**
 * pix-gate — prompt.ts
 *
 * Thin adapter: maps gate severity/rule → showOverlay (pix-pretty).
 * All dialog logic lives in @xynogen/pix-pretty/gate-overlay.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type OverlayResult, showOverlay } from "@xynogen/pix-pretty/gate-overlay";
import type { PathRule, Rule } from "./lib.ts";

export interface GateDecision {
	approved: boolean;
	/** "Approved" | "Blocked by user" | "Timed out" */
	reason: string;
}

/** Single concern — path hit or command hit — shown in the merged dialog body. */
export interface Concern {
	icon: string;
	label: string;
	detail: string;
	/** Highest severity tier (for dialog behavior). "critical" > "block" > "dangerous" > "warn" > "risky". */
	tier: number;
}

export type GatePromptUI = ExtensionContext["ui"];

/** Title Case a severity tier for dialog titles: "critical" → "Critical". */
function titleCase(word: string): string {
	return word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : word;
}

const TIMEOUT_MS: Record<Rule["severity"], number> = {
	critical: 15_000,
	dangerous: 30_000,
	risky: 60_000,
};

const SEVERITY_COLOR: Record<Rule["severity"], string> = {
	critical: "error",
	dangerous: "warning",
	risky: "accent",
};

export const SEVERITY_ICON: Record<Rule["severity"], string> = {
	critical: "🛑",
	dangerous: "⚠️ ",
	risky: "❓",
};

const PATH_SEVERITY_COLOR: Record<PathRule["severity"], string> = {
	block: "error",
	warn: "warning",
	info: "accent",
};

export const PATH_SEVERITY_ICON: Record<PathRule["severity"], string> = {
	block: "🔴",
	warn: "🟡",
	info: "🔵",
};

const PATH_TIMEOUT_MS: Record<PathRule["severity"], number> = {
	block: 15_000,
	warn: 30_000,
	info: 0, // info never shows a dialog
};

/**
 * Show confirm/deny dialog for a path access.
 * block: deny-first. warn: allow-first. info: never called (notify only).
 */
export async function promptPathDecision(
	ui: GatePromptUI,
	hit: PathRule,
	op: string,
	path: string,
): Promise<GateDecision> {
	const icon = PATH_SEVERITY_ICON[hit.severity];
	const label = titleCase(hit.severity);
	const accent = PATH_SEVERITY_COLOR[hit.severity];

	const choices =
		hit.severity === "block"
			? [
					{
						value: "no",
						label: "No, block it",
						description: "Deny this file access",
					},
					{
						value: "yes",
						label: "Yes, I know what I'm doing",
						description: "Allow once",
					},
				]
			: [
					{
						value: "yes",
						label: "Yes, allow",
						description: "Proceed with file access",
					},
					{
						value: "no",
						label: "No, block it",
						description: "Deny this file access",
					},
				];

	const result: OverlayResult = await showOverlay(ui as Parameters<typeof showOverlay>[0], {
		mode: "confirm",
		icon,
		title: `${label} — ${hit.reason}`,
		body: [`${op.toUpperCase()} ${path}`],
		accent,
		timeoutMs: PATH_TIMEOUT_MS[hit.severity],
		choices,
	});

	if (result.action === "approved") return { approved: true, reason: "Approved" };
	if (result.action === "timeout") return { approved: false, reason: "Timed out" };
	return { approved: false, reason: "Blocked by user" };
}

/** Tier for dialog behavior — higher = more restrictive (deny-first, shorter timeout). */
const SEVERITY_TIER: {
	critical: number;
	block: number;
	dangerous: number;
	warn: number;
	risky: number;
} = {
	critical: 5,
	block: 4,
	dangerous: 3,
	warn: 2,
	risky: 1,
};

/**
 * Show a single merged dialog for a bash command that hit BOTH path rules AND
 * command-gate rules. Combines all concerns under one title, one confirm/deny.
 */
export async function promptMergedGateDecision(
	ui: GatePromptUI,
	concerns: Concern[],
	command: string,
): Promise<GateDecision> {
	// Sort by tier desc so the highest-severity concern drives dialog behavior.
	const sorted = [...concerns].sort((a, b) => b.tier - a.tier);
	const highest = sorted[0];
	if (!highest) throw new Error("promptMergedGateDecision requires at least one concern");
	const isRestrictive = highest.tier >= SEVERITY_TIER.block; // block or critical

	// Title: unique severity types, joined with " + "
	const seenLabels = new Set<string>();
	const uniqueLabels: string[] = [];
	for (const c of sorted) {
		const key = `${c.icon} ${c.label}`;
		if (!seenLabels.has(key)) {
			seenLabels.add(key);
			uniqueLabels.push(key);
		}
	}
	const titleSuffix = command.length > 55 ? `${command.slice(0, 52)}…` : command;
	const title = `${uniqueLabels.join(" + ")} — ${titleSuffix}`;

	// Body: command + concern list
	const body = [command, "", ...sorted.map((c) => `${c.icon} ${c.label} — ${c.detail}`)];

	const accent =
		highest.tier >= SEVERITY_TIER.critical
			? "error"
			: highest.tier >= SEVERITY_TIER.block
				? "error"
				: highest.tier >= SEVERITY_TIER.dangerous
					? "warning"
					: "accent";

	const timeoutMs =
		highest.tier >= SEVERITY_TIER.block
			? TIMEOUT_BY_TIER.block
			: highest.tier >= SEVERITY_TIER.dangerous
				? TIMEOUT_BY_TIER.dangerous
				: TIMEOUT_BY_TIER.risky;

	const choices = isRestrictive
		? [
				{
					value: "no",
					label: "No, block it",
					description: "Prevent this command from running",
				},
				{
					value: "yes",
					label: "Yes, I understand the risk",
					description: "Allow once",
				},
			]
		: [
				{ value: "yes", label: "Yes, allow", description: "Run the command" },
				{
					value: "no",
					label: "No, block it",
					description: "Prevent this command from running",
				},
			];

	const result: OverlayResult = await showOverlay(ui as Parameters<typeof showOverlay>[0], {
		mode: "confirm",
		title,
		body,
		accent,
		timeoutMs,
		choices,
	});

	if (result.action === "approved") return { approved: true, reason: "Approved" };
	if (result.action === "timeout") return { approved: false, reason: "Timed out" };
	return { approved: false, reason: "Blocked by user" };
}

const TIMEOUT_BY_TIER: Record<string, number> = {
	block: 15_000,
	dangerous: 30_000,
	risky: 60_000,
};

/**
 * Show the confirm/deny dialog for a matched command.
 * Critical is deny-first; dangerous/risky are allow-first.
 */
export async function promptGateDecision(
	ui: GatePromptUI,
	hit: Rule,
	command: string,
): Promise<GateDecision> {
	const icon = SEVERITY_ICON[hit.severity];
	const label = titleCase(hit.severity);
	const accent = SEVERITY_COLOR[hit.severity];

	// critical: deny listed first so it's the default selected item
	const choices =
		hit.severity === "critical"
			? [
					{
						value: "no",
						label: "No, block it",
						description: "Prevent this command from running",
					},
					{
						value: "yes",
						label: "Yes, I understand the risk",
						description: "Allow once",
					},
				]
			: [
					{ value: "yes", label: "Yes, allow", description: "Run the command" },
					{
						value: "no",
						label: "No, block it",
						description: "Prevent this command from running",
					},
				];

	const result: OverlayResult = await showOverlay(ui as Parameters<typeof showOverlay>[0], {
		mode: "confirm",
		icon,
		title: `${label} — ${hit.reason}`,
		body: [command],
		accent,
		timeoutMs: TIMEOUT_MS[hit.severity],
		choices,
	});

	if (result.action === "approved") return { approved: true, reason: "Approved" };
	if (result.action === "timeout") return { approved: false, reason: "Timed out" };
	return { approved: false, reason: "Blocked by user" };
}
