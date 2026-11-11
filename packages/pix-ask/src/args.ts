import { validateToolArguments } from "@xynogen/pix-data/ai";
import { MAX_HEADER_LENGTH, MAX_LABEL_LENGTH, type Params, ParamsSchema } from "./schema.ts";

const FIX = "Fix: resend the call with only these fields corrected.";

// ponytail: pix-edit has a copy of this host-error reformatter (clip/badArgs/checkArgs). Move it
// to pix-runtime when a third tool needs it (public API addition, minor bump).
const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

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
	try {
		validateToolArguments(
			{ name: "ask_user", description: "", parameters: ParamsSchema },
			{ type: "toolCall", id: "", name: "ask_user", arguments: args as never },
		);
		return args as Params;
	} catch (error) {
		// ponytail: reads pi-ai's "  - path: problem" rows; an unknown format rethrows the host error.
		const text = (error instanceof Error ? error.message : String(error)).split(
			"\n\nReceived arguments:",
		)[0];
		const seen = new Set<string>();
		const rows = [...(text ?? "").matchAll(/^ {2}- (\S+): (.+)$/gm)].map(
			([, path = "", problem = ""]) => {
				const value =
					path === "root"
						? args
						: path
								.split(".")
								.reduce<unknown>(
									(v, k) =>
										v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined,
									args,
								);
				const shown =
					value === undefined ? "" : ` ${clip(JSON.stringify(value) ?? String(value), 40)}`;
				// State a repeated fix once, so five rows stay a few hundred bytes.
				const advice = askFix(path, problem, value);
				const said = seen.has(advice);
				seen.add(advice);
				return `- ${path.replace(/\.(\d+)/g, "[$1]")}${shown}: ${said ? "same fix" : advice}`;
			},
		);
		if (!rows.length) throw error;
		const head =
			rows.length > 5
				? `ask_user: ${rows.length} bad arguments, first 5`
				: "ask_user: bad arguments";
		throw new Error([head, ...rows.slice(0, 5), FIX].join("\n"));
	}
}
