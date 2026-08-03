/**
 * persist.ts — disk-backed persistence for the /optimizer tool states.
 *
 * caveman/ponytail previously saved only to the session log (lost on a fresh
 * session); rtk never persisted at all. This stores every tool's current
 * value in one file under the agent dir so the picker survives a full quit and
 * restart. Each tool reads its value on session_start and writes on run().
 *
 *   ~/.pi/agent/optimizer.json  →  { "caveman": "lite", "rtk": "on", ... }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { OptimizerTool } from "./status.ts";

type OptimizerFileConfig = Partial<Record<OptimizerTool, string>>;

const OPTIMIZER_TOOLS: readonly OptimizerTool[] = ["caveman", "rtk", "ponytail"];

function getStatePath(): string {
	return join(getAgentDir(), "optimizer.json");
}

function readFile(): OptimizerFileConfig {
	try {
		const sp = getStatePath();
		if (!existsSync(sp)) return {};
		const raw = JSON.parse(readFileSync(sp, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

		const config: OptimizerFileConfig = {};
		for (const tool of OPTIMIZER_TOOLS) {
			const value = (raw as Record<string, unknown>)[tool];
			if (typeof value === "string") config[tool] = value;
		}
		return config;
	} catch {
		return {};
	}
}

/** Read a single tool's persisted value from optimizer.json. */
export function loadOptValue(tool: OptimizerTool): string | undefined {
	return readFile()[tool];
}

/** Persist a single tool's value, merging into the shared config file. */
export function saveOptValue(tool: OptimizerTool, value: string): void {
	try {
		const sp = getStatePath();
		mkdirSync(dirname(sp), { recursive: true });
		const next = { ...readFile(), [tool]: value };
		writeFileSync(sp, JSON.stringify(next, null, 2), "utf-8");
	} catch (err) {
		console.warn(`optimizer: persist ${tool} failed:`, err);
	}
}
