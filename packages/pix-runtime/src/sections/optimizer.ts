import { defineSection, enumOrDefault, isPlainObject } from "../schema.ts";

export type CavemanLevel = "off" | "lite" | "full" | "ultra" | "micro";
export type PonytailLevel = "off" | "lite" | "full" | "ultra";
export type Toggle = "off" | "on";

export interface OptimizerConfig {
	caveman: CavemanLevel;
	rtk: Toggle;
	ponytail: PonytailLevel;
}

const CAVEMAN: readonly CavemanLevel[] = ["off", "lite", "full", "ultra", "micro"];
const PONYTAIL: readonly PonytailLevel[] = ["off", "lite", "full", "ultra"];
const TOGGLE: readonly Toggle[] = ["off", "on"];

const DEFAULTS: Readonly<OptimizerConfig> = {
	caveman: "off",
	rtk: "on",
	ponytail: "off",
};

export const optimizerSection = defineSection<"optimizer", OptimizerConfig>({
	key: "optimizer",
	defaults: DEFAULTS,
	parse(raw) {
		if (!isPlainObject(raw)) return { ...DEFAULTS };
		return {
			caveman: enumOrDefault(raw.caveman, CAVEMAN, DEFAULTS.caveman),
			rtk: enumOrDefault(raw.rtk, TOGGLE, DEFAULTS.rtk),
			ponytail: enumOrDefault(raw.ponytail, PONYTAIL, DEFAULTS.ponytail),
		};
	},
});
