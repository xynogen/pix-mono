import { boolOr, defineSection, isObj } from "../schema.ts";

export interface EditConfig {
	/** Restore the file and fail the edit when LSP reports new syntax errors after it. */
	rejectNewSyntaxErrors: boolean;
}

const DEFAULTS: Readonly<EditConfig> = {
	rejectNewSyntaxErrors: false,
};

export const editSection = defineSection<"edit", EditConfig>({
	key: "edit",
	defaults: DEFAULTS,
	parse(raw) {
		if (!isObj(raw)) return { ...DEFAULTS };
		return {
			rejectNewSyntaxErrors: boolOr(raw.rejectNewSyntaxErrors, DEFAULTS.rejectNewSyntaxErrors),
		};
	},
});
