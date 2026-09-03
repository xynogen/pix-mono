import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomicSync } from "@xynogen/pix-runtime/atomic-write";
import { getAgentPath } from "./agent-dir.ts";

export interface McpOnboardingState {
	version: 1;
	sharedConfigHintShown: boolean;
	setupCompleted: boolean;
	lastDiscoveryFingerprint?: string;
}

const DEFAULT_STATE: McpOnboardingState = {
	version: 1,
	sharedConfigHintShown: false,
	setupCompleted: false,
};

export function getOnboardingStatePath(): string {
	return getAgentPath("mcp-onboarding.json");
}

export function loadOnboardingState(): McpOnboardingState {
	const path = getOnboardingStatePath();
	if (!existsSync(path)) return { ...DEFAULT_STATE };

	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<McpOnboardingState>;
		if (!raw || typeof raw !== "object") return { ...DEFAULT_STATE };
		return {
			version: 1,
			sharedConfigHintShown: raw.sharedConfigHintShown === true,
			setupCompleted: raw.setupCompleted === true,
			lastDiscoveryFingerprint:
				typeof raw.lastDiscoveryFingerprint === "string" ? raw.lastDiscoveryFingerprint : undefined,
		};
	} catch {
		return { ...DEFAULT_STATE };
	}
}

export function updateOnboardingState(
	updater: (state: McpOnboardingState) => McpOnboardingState,
): McpOnboardingState {
	const next = updater(loadOnboardingState());
	writeFileAtomicSync(getOnboardingStatePath(), `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

export function markSharedConfigHintShown(fingerprint?: string): McpOnboardingState {
	return updateOnboardingState((state) => ({
		...state,
		sharedConfigHintShown: true,
		lastDiscoveryFingerprint: fingerprint ?? state.lastDiscoveryFingerprint,
	}));
}

export function markSetupCompleted(fingerprint?: string): McpOnboardingState {
	return updateOnboardingState((state) => ({
		...state,
		setupCompleted: true,
		lastDiscoveryFingerprint: fingerprint ?? state.lastDiscoveryFingerprint,
	}));
}
