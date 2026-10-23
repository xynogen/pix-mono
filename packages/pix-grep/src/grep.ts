import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	ExtensionContext,
	GrepToolInput,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import {
	BATCH_MAX_BYTES,
	type BatchSection,
	capSections,
	formatBatchIndex,
	formatCallTargets,
	joinSectionBodies,
	resolveBatchStrings,
	sliceBatchTargets,
	withOptionalStringArray,
} from "@xynogen/pix-pretty/batch";
import type { ToolContext } from "@xynogen/pix-pretty/context";
import { fffFormatGrepText } from "@xynogen/pix-pretty/fff";
import type {
	GrepParams,
	GrepResultDetails,
	PiPrettyApi,
	RenderContextLike,
	ThemeLike,
	ToolFactory,
	ToolResultLike,
} from "@xynogen/pix-pretty/types";
import {
	appendNotices,
	countRipgrepMatches,
	fillToolBackground,
	formatToolCallTitle,
	frameToolResult,
	getErrorMessage,
	getTextContent,
	hideCollapsedToolCall,
	isTextContent,
	makeTextResult,
	normalizeLineEndings,
	pluralize,
	renderCollapsedToolRow,
	renderDimPreview,
	renderToolError,
	setResultDetails,
	unframeToolResult,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { anchor, decodeLines, initHashline, type SourceLine } from "@xynogen/pix-runtime/hashline";

export const DEFAULT_GREP_LIMIT = 30;

const MATCH_NOUNS = ["match", "matches"] as const;

/** GrepParams plus the optional batch `patterns` array (added to the schema at runtime). */
type GrepBatchParams = GrepParams & { patterns?: string[] };

export function applyGrepDefaults(params: GrepParams): GrepParams {
	return params.limit === undefined ? { ...params, limit: DEFAULT_GREP_LIMIT } : params;
}

/** Files above this size keep plain `path:LINE:` rows (anchoring reads the whole file). */
const ANCHOR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Add read/edit anchors to grep match rows: `path:LINE:text` → `path:LINE#HASH|text`,
 * so the model can call `edit` from a grep hit without a `read` first (The Harness
 * Problem: anchors in read and grep). The hash is taken from the full source line,
 * not grep's truncated text. A row whose file or line cannot be read stays as is.
 * `sep` is what follows `LINE:` — FFF writes none, Pi's ripgrep writes one space.
 * `base` is the search root; when it is a file, rows name only its basename.
 */
export async function anchorGrepText(text: string, base: string, sep: "" | " "): Promise<string> {
	await initHashline();
	const row = new RegExp(`^(.+?):(\\d+):${sep}(.*)$`);
	const baseIsFile = await stat(base).then(
		(s) => s.isFile(),
		() => false,
	);
	const files = new Map<string, Promise<SourceLine[] | undefined>>();
	const linesOf = (rel: string) => {
		const path = baseIsFile ? base : join(base, rel);
		let lines = files.get(path);
		if (!lines) {
			lines = stat(path)
				.then(async (s) =>
					s.size > ANCHOR_MAX_BYTES ? undefined : decodeLines(await readFile(path)).lines,
				)
				.catch(() => undefined);
			files.set(path, lines);
		}
		return lines;
	};
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const m = row.exec(line);
		const n = Number(m?.[2]);
		const source = m ? (await linesOf(m[1] ?? ""))?.[n - 1] : undefined;
		out.push(source && m ? `${m[1]}:${anchor(n, source.text)}|${m[3]}` : line);
	}
	return out.join("\n");
}

/** Renderer view: drop the anchor hash, keep `path:LINE:text`. */
export function stripGrepAnchors(text: string): string {
	return text.replace(/^(.+?:\d+)#[0-9A-F]{3}\|/gm, "$1:");
}

/**
 * Build the highlight argument for renderDimPreview from a grep result.
 * A literal search returns the raw string (utils escapes it, case-insensitive).
 * A regex search compiles the pattern so real regex matches light up too;
 * an invalid regex falls back to a literal highlight of the source text.
 */
export function grepHighlight(d: GrepResultDetails): string | RegExp {
	if (d.literal) return d.pattern;
	try {
		return new RegExp(d.pattern, d.ignoreCase ? "gi" : "g");
	} catch {
		return d.pattern;
	}
}

export function registerGrepTool(
	pi: PiPrettyApi,
	createGrepTool: ToolFactory<GrepToolInput>,
	ctx: ToolContext,
): void {
	const { cwd, sp, TextComponent, fffState, cursorStore } = ctx;
	const origGrep = createGrepTool(cwd);

	pi.registerTool({
		...origGrep,
		name: "grep",
		description:
			"Search file contents for a regex or literal pattern. Defaults to 30 matches; use limit to request more. Respects .gitignore and remains capped by Pi's 50KB hard limit. Pass `patterns` to search several known patterns in one call. Match rows are `path:LINE#HASH|text`; `LINE#HASH` is a valid edit anchor.",
		parameters: withOptionalStringArray(
			origGrep.parameters,
			"patterns",
			"Known patterns to search in one call (each capped, one combined result). Use instead of `pattern` for multiple known patterns.",
			["pattern"],
		),
		renderShell: "self",

		async execute(
			tid: string,
			params: GrepBatchParams,
			sig: AbortSignal | undefined,
			upd: unknown,
			toolCtx: ExtensionContext,
		) {
			// Search one pattern (FFF-accelerated, SDK fallback) → structured grep result.
			const runOne = async (
				pattern: string,
				callId: string,
			): Promise<ToolResultLike<GrepResultDetails>> => {
				const { patterns: _patterns, ...rest } = params;
				const effectiveParams = applyGrepDefaults({ ...rest, pattern });
				const root = toolCtx?.cwd || cwd;

				// Try FFF first (SIMD-accelerated).
				// Constrained searches (path/glob) fall through to SDK — FFF 0.5.2
				// can abort the process on constrained searches with Unicode filenames.
				if (
					fffState.finder &&
					!fffState.finder.isDestroyed &&
					!effectiveParams.path &&
					!effectiveParams.glob
				) {
					try {
						const effectiveLimit = Math.max(1, effectiveParams.limit ?? DEFAULT_GREP_LIMIT);
						const grepResult = fffState.finder.grep(effectiveParams.pattern, {
							mode: effectiveParams.literal ? "plain" : "regex",
							smartCase: !effectiveParams.ignoreCase,
							maxMatchesPerFile: Math.min(effectiveLimit, 50),
							cursor: null,
							beforeContext: effectiveParams.context ?? 0,
							afterContext: effectiveParams.context ?? 0,
						});

						if (grepResult.ok) {
							const grep = grepResult.value;
							const notices: string[] = [];
							if (fffState.partialIndex) notices.push("Warning: partial file index");
							if (grep.items.length >= effectiveLimit)
								notices.push(`${effectiveLimit} limit reached`);
							if (grep.regexFallbackError)
								notices.push(`Regex failed: ${grep.regexFallbackError}, used literal match`);
							// SWE-agent ablation: paging through matches one window at a time cost
							// 6 points on SWE-bench Lite; agents page exhaustively. Lead with a
							// narrower query, keep the cursor as the fallback.
							if (grep.nextCursor) {
								const cursorId = cursorStore.store(grep.nextCursor);
								notices.push(
									`More results available. Narrow the pattern, path or glob first; cursor="${cursorId}" continues only if you need every match`,
								);
							}

							const textContent = appendNotices(
								await anchorGrepText(fffFormatGrepText(grep.items, effectiveLimit), root, ""),
								notices,
							);
							return makeTextResult<GrepResultDetails>(textContent, {
								_type: "grepResult",
								text: textContent,
								pattern: effectiveParams.pattern,
								path: effectiveParams.path,
								matchCount: Math.min(grep.items.length, effectiveLimit),
								literal: effectiveParams.literal,
								ignoreCase: effectiveParams.ignoreCase,
							});
						}
					} catch {
						/* fall through to SDK */
					}
				}

				// SDK fallback
				const result = await origGrep.execute(callId, effectiveParams, sig, upd as never, toolCtx);
				const raw = normalizeLineEndings(getTextContent(result));
				const textContent = await anchorGrepText(
					raw,
					resolve(root, effectiveParams.path ?? "."),
					" ",
				);
				if (result.content)
					result.content = [
						{ type: "text", text: textContent },
						...result.content.filter((c) => !isTextContent(c)),
					];
				setResultDetails<GrepResultDetails>(result, {
					_type: "grepResult",
					text: textContent,
					pattern,
					path: effectiveParams.path,
					matchCount: raw ? countRipgrepMatches(raw) : 0,
					literal: effectiveParams.literal,
					ignoreCase: effectiveParams.ignoreCase,
				});
				return result as ToolResultLike<GrepResultDetails>;
			};

			const { targets, omitted } = sliceBatchTargets(
				resolveBatchStrings(params.pattern, params.patterns),
			);
			if (targets.length === 0) {
				return makeTextResult<GrepResultDetails>("pattern or patterns required", {
					_type: "grepResult",
					text: "pattern or patterns required",
					pattern: "",
					path: params.path,
					matchCount: 0,
				});
			}

			// Single pattern → preserve the original single-search result shape.
			if (targets.length === 1 && omitted === 0) {
				try {
					return await runOne(targets[0] ?? "", tid);
				} catch (error) {
					const text = getErrorMessage(error);
					if (sig?.aborted || /aborted/i.test(text)) throw error;
					return {
						content: [{ type: "text" as const, text }],
						details: {
							_type: "grepResult" as const,
							text,
							pattern: params.pattern ?? "",
							path: params.path,
							matchCount: 0,
							literal: params.literal,
							ignoreCase: params.ignoreCase,
						},
						isError: true,
					};
				}
			}

			// Batch: search every pattern in parallel, cap the combined output.
			const settled = await Promise.all(
				targets.map(async (pattern, i) => {
					try {
						return { pattern, result: await runOne(pattern, `${tid}:${i}`) };
					} catch (error) {
						if (sig?.aborted) throw error;
						return { pattern, error: getErrorMessage(error) };
					}
				}),
			);
			const sections: BatchSection[] = settled.map((entry) => {
				if ("error" in entry && entry.error) {
					return { id: entry.pattern, body: "", units: 0, nouns: MATCH_NOUNS, error: entry.error };
				}
				const details = (entry as { result: ToolResultLike<GrepResultDetails> }).result.details;
				const body =
					details?._type === "grepResult"
						? details.text
						: getTextContent((entry as { result: ToolResultLike }).result);
				const units =
					details?._type === "grepResult" ? details.matchCount : countRipgrepMatches(body);
				return { id: entry.pattern, body, units, nouns: MATCH_NOUNS };
			});
			const { text } = capSections(
				sections,
				BATCH_MAX_BYTES,
				params.limit ?? DEFAULT_GREP_LIMIT,
				omitted,
			);
			const matchCount = sections.reduce((sum, s) => sum + (s.error ? 0 : s.units), 0);
			const full = [formatBatchIndex(sections, omitted), joinSectionBodies(sections)]
				.filter(Boolean)
				.join("\n\n");
			return makeTextResult<GrepResultDetails>(text, {
				_type: "grepResult",
				text: full,
				pattern: targets.join(", "),
				patterns: targets,
				path: params.path,
				matchCount,
			});
		},

		renderCall(args: GrepBatchParams, theme: ThemeLike, renderCtx: RenderContextLike) {
			resolveBaseBackground(theme);
			const batchPatterns = resolveBatchStrings(args.pattern, args.patterns);
			const pattern =
				batchPatterns.length > 1
					? formatCallTargets(batchPatterns, 3, "patterns")
					: (args.pattern ?? "");
			const path = args.path ? ` ${theme.fg("muted", `in ${sp(args.path)}`)}` : "";
			const glob = args.glob ? ` ${theme.fg("muted", `(${args.glob})`)}` : "";
			const text = renderCtx.lastComponent ?? new TextComponent("", 0, 0);
			if (
				hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
					text.setText(value),
				)
			)
				return text;
			text.setText(
				fillToolBackground(
					`${formatToolCallTitle(theme, "grep", renderCtx)} ${theme.fg("dim", pattern)}${path}${glob}`,
				),
			);
			return text;
		},

		renderResult(
			result: ToolResultLike<GrepResultDetails>,
			_opt: ToolRenderResultOptions,
			theme: ThemeLike,
			renderCtx: RenderContextLike,
		) {
			resolveBaseBackground(theme);
			const text = unframeToolResult(renderCtx.lastComponent ?? new TextComponent("", 0, 0));
			const d = result.details;
			const isPartial = _opt?.isPartial === true;
			const completed = () => frameToolResult(text, theme, renderCtx.isError);
			const structuredError = renderCtx.isError && d?._type === "grepResult";

			if (renderCtx.isError && (!structuredError || isPartial)) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return isPartial ? text : completed();
			}

			// Auto-collapse: show summary line after delay
			const cs = renderCtx.state as CollapseState;
			if (!isPartial && tickCollapse("grep", cs, renderCtx.invalidate, renderCtx.expanded)) {
				const summary =
					d?._type === "grepResult" ? pluralize(d.matchCount, "match", "matches") : "searched";
				const target = d?._type === "grepResult" ? `“${d.pattern}”` : "";
				const scope = d?._type === "grepResult" && d.path ? ` in ${sp(d.path)}` : "";
				text.setText(
					renderCollapsedToolRow(
						theme,
						"grep",
						`${target}${scope}`,
						renderCtx.isError ? "failed" : summary,
						renderCtx.isError ? "error" : "success",
					),
				);
				return text;
			}

			if (renderCtx.isError) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return completed();
			}

			const output = stripGrepAnchors(getTextContent(result)) || "searched";
			// One framed shape; rules follow status color. Count lives in the collapsed row.
			text.setText(
				renderDimPreview(output, theme, {
					frame: !isPartial,
					paint: (s: string) => theme.fg(renderCtx.isError ? "error" : "success", s),
					highlight: d?._type === "grepResult" && !d.patterns ? grepHighlight(d) : undefined,
				}),
			);
			return text;
		},
	});
}
