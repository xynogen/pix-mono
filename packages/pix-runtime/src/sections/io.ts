import { defineSection, isPlainObject, positiveNumberOrDefault } from "../schema.ts";

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
		if (!isPlainObject(raw)) return { ...DEFAULTS };
		return {
			timeoutSec: positiveNumberOrDefault(raw.timeoutSec, DEFAULTS.timeoutSec),
		};
	},
});
