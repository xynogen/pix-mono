import { checkArgs } from "@xynogen/pix-runtime/files";
import { MAX_HEADER_LENGTH, MAX_LABEL_LENGTH, type Params, ParamsSchema } from "./schema.ts";

const FIX = "Fix: resend the call with only these fields corrected.";

const parseJson = (value: unknown): unknown => {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};

function askFix(path: string, problem: string, value: unknown): string {
	const length = typeof value === "string" ? value.length : 0;
	if (/\.header$/.test(path) && problem.startsWith("expected at most"))
		return `${length} chars, max ${MAX_HEADER_LENGTH}; shorten the chip tag`;
	if (/\.label$/.test(path) && problem.startsWith("expected at most"))
		return `${length} chars, max ${MAX_LABEL_LENGTH}; put detail in description`;
	if (/\.options\.\d+$/.test(path))
		return `${problem}; each option is {label, description, preview?}`;
	if (/^questions\.\d+$/.test(path))
		return `${problem}; each question is {question, header, options, multiSelect?}`;
	return problem;
}

// "All …" next to "Only …" in a single-select means the model pre-bundled a subset pick.
const BUNDLE_ALL = /^(all|both)\b/i;
const BUNDLE_ONLY = /^only\b/i;

function bundledSubsetRows(params: Params): string[] {
	return params.questions.flatMap((question, i) => {
		if (question.multiSelect) return [];
		const labels = question.options.map((option) => option.label.trim());
		if (!labels.some((l) => BUNDLE_ALL.test(l)) || !labels.some((l) => BUNDLE_ONLY.test(l)))
			return [];
		return [
			`- questions[${i}].options: single-select bundles subsets ("All" / "Only …"); set multiSelect: true with one option per item`,
		];
	});
}

/**
 * Normalize JSON-string payloads, then check with the host validator. A bad call
 * fails with a few lines that name the field, its length and limit, and the fix.
 * Never truncates silently: an over-long header or label is the model's to shorten.
 */
export function prepareAskArguments(input: unknown): Params {
	const object = input && typeof input === "object" && !Array.isArray(input);
	const args = (object ? { ...input } : input) as Record<string, unknown>;
	if (object) {
		args.questions = parseJson(args.questions);
		if (Array.isArray(args.questions)) args.questions = args.questions.map(parseJson);
	}
	checkArgs("ask_user", ParamsSchema, args, askFix, FIX);
	const params = args as Params;
	const bundled = bundledSubsetRows(params);
	if (bundled.length) throw new Error(["ask_user: bad arguments", ...bundled, FIX].join("\n"));
	return params;
}
