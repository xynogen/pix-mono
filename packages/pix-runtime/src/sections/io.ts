import { defineSection, isObj, posNumOr } from "../schema.ts";

export interface IoConfig {
	/** Default timeout in seconds for Pix network requests. */
	timeoutSec: number;
}

const DEFAULTS: Readonly<IoConfig> = {
	timeoutSec: 30,
};

export const ioSection = defineSection<"io", IoConfig>({
	key: "io",
	defaults: DEFAULTS,
	parse(raw) {
		if (!isObj(raw)) return { ...DEFAULTS };
		return {
			timeoutSec: posNumOr(raw.timeoutSec, DEFAULTS.timeoutSec),
		};
	},
});
