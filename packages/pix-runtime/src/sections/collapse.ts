import { boolOrDefault, defineSection, isPlainObject, positiveNumberOrDefault } from "../schema.ts";

export interface CollapseConfig {
	/** Master toggle. `false` = never collapse any tool. Default `true`. */
	enabled: boolean;
	/** Seconds before a tool card collapses. Default `10`. */
	delaySec: number;
	/** Per-tool overrides. Missing key follows `enabled`. */
	tools: Partial<Record<string, boolean>>;
}

const DEFAULTS: Readonly<CollapseConfig> = {
	enabled: true,
	delaySec: 10,
	tools: {},
};

export const collapseSection = defineSection<"collapse", CollapseConfig>({
	key: "collapse",
	defaults: DEFAULTS,
	parse(raw) {
		if (!isPlainObject(raw)) return { ...DEFAULTS, tools: {} };
		const tools: Partial<Record<string, boolean>> = {};
		if (isPlainObject(raw.tools)) {
			for (const [k, v] of Object.entries(raw.tools)) {
				if (typeof v === "boolean") tools[k] = v;
			}
		}
		return {
			enabled: boolOrDefault(raw.enabled, DEFAULTS.enabled),
			delaySec: positiveNumberOrDefault(raw.delaySec, DEFAULTS.delaySec),
			tools,
		};
	},
});
