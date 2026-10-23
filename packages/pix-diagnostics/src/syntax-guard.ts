/**
 * syntax-guard.ts — opt-in `edit.rejectNewSyntaxErrors` (pix.json).
 *
 * Before an edit the guard keeps the file bytes and its syntax errors. After the
 * edit, a syntax error that was not there before restores the bytes and fails
 * the edit with the errors and fresh anchors (SWE-agent: −3 points without it).
 * Only syntax errors count: type errors are normal mid-refactor.
 */

import { anchor, decodeLines, initHashline } from "@xynogen/pix-runtime/hashline";
import type { PixDiagnostic } from "./types.ts";

/** TypeScript reports syntax (parser) errors as codes 1000–1999. */
const TS_SYNTAX = /^(ts|typescript)$/i;
const SYNTAX_MESSAGE = /\b(syntax|parse|parsing|unexpected|expected|unterminated|unclosed)\b/i;
const CONTEXT = 2;
const MAX_ANCHOR_LINES = 20;

export function isSyntaxError(d: PixDiagnostic): boolean {
	if (d.severity !== "error") return false;
	if (typeof d.code === "number" && TS_SYNTAX.test(d.source ?? "typescript"))
		return d.code >= 1000 && d.code < 2000;
	return SYNTAX_MESSAGE.test(d.message);
}

/** Syntax errors in `after` that `before` did not have. Lines move, so match by code + message. */
export function newSyntaxErrors(
	before: readonly PixDiagnostic[],
	after: readonly PixDiagnostic[],
): PixDiagnostic[] {
	const seen = new Map<string, number>();
	const key = (d: PixDiagnostic) => `${d.code ?? ""}\u0000${d.message}`;
	for (const d of before.filter(isSyntaxError)) seen.set(key(d), (seen.get(key(d)) ?? 0) + 1);
	return after.filter(isSyntaxError).filter((d) => {
		const left = seen.get(key(d)) ?? 0;
		if (left > 0) seen.set(key(d), left - 1);
		return left === 0;
	});
}

/** The failure text: the new errors, then anchors of the restored file around them. */
export async function rejectionText(
	path: string,
	errors: readonly PixDiagnostic[],
	restored: Uint8Array,
): Promise<string> {
	await initHashline();
	const { lines } = decodeLines(restored);
	const wanted = new Set<number>();
	for (const e of errors) {
		for (let n = e.line - CONTEXT; n <= e.line + CONTEXT; n++)
			if (n >= 1 && n <= lines.length) wanted.add(n);
	}
	const rows = [...wanted].sort((a, b) => a - b);
	const shown = rows.slice(0, MAX_ANCHOR_LINES);
	const anchors: string[] = [];
	shown.forEach((n, i) => {
		if (i > 0 && n !== (shown[i - 1] ?? 0) + 1) anchors.push("…");
		const text = lines[n - 1]?.text ?? "";
		anchors.push(`${anchor(n, text)}|${text}`);
	});
	if (rows.length > shown.length)
		anchors.push(`… ${rows.length - shown.length} more lines; read for anchors`);
	return [
		`Edit rejected: it adds ${errors.length} syntax error(s) to ${path}. The file is restored.`,
		...errors.map((e) => `${e.line}:${e.column} ${e.code ?? ""} ${e.message}`.replace(/\s+/g, " ")),
		"Error lines are in the rejected version. Current anchors (restored file):",
		...anchors,
	].join("\n");
}
