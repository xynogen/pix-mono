import { boolOrDefault, defineSection, isPlainObject } from "../schema.ts";

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
		if (!isPlainObject(raw)) return { ...DEFAULTS };
		return {
			rejectNewSyntaxErrors: boolOrDefault(
				raw.rejectNewSyntaxErrors,
				DEFAULTS.rejectNewSyntaxErrors,
			),
		};
	},
});
