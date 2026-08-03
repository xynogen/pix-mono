import { defineSection, enumOr, isObj } from "../schema.ts";

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
		if (!isObj(raw)) return { ...DEFAULTS };
		return {
			caveman: enumOr(raw.caveman, CAVEMAN, DEFAULTS.caveman),
			rtk: enumOr(raw.rtk, TOGGLE, DEFAULTS.rtk),
			ponytail: enumOr(raw.ponytail, PONYTAIL, DEFAULTS.ponytail),
		};
	},
});
