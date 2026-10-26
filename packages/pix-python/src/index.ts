/**
 * pix-python — `python_run` tool.
 *
 * A friendlier front door for the Python snippets models otherwise push
 * through `bash` (`python3 -c "…"` / `python3 - <<EOF`). Not a sandbox: the
 * code runs as the user with the local `python3`, in the session cwd.
 *
 * - `intent` is required and shown everywhere (approval, call row, collapsed row).
 * - Indentation is repaired before running (tabs, CRLF, fences, shared indent).
 * - The script goes in on stdin, so there is no shell quoting to get wrong.
 * - Approval overlay like sudo_run: Allow · Allow for this session · Deny.
 *   /yolo approves, /afk denies unless the session is already allowed.
 */

import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import { collapsedCommandRow } from "@xynogen/pix-pretty/command-preview";
import { MAX_PREVIEW_LINES } from "@xynogen/pix-pretty/config";
import { showOverlay } from "@xynogen/pix-pretty/gate-overlay";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { renderFileContent } from "@xynogen/pix-pretty/renderers";
import type { RenderContextLike, ThemeLike, ToolResultLike } from "@xynogen/pix-pretty/types";
import {
	BODY_PAD,
	bodyLine,
	dotJoin,
	fillToolBackground,
	formatCollapsedToolRow,
	formatToolCallTitle,
	frameToolResult,
	getErrorMessage,
	getTextContent,
	hideCollapsedToolCall,
	moreLines,
	normalizeLineEndings,
	renderToolError,
	unframeToolResult,
} from "@xynogen/pix-pretty/utils";
import { formatDuration } from "@xynogen/pix-pretty/widget-format";
import { getUnattendedMode, withAgentBlock } from "@xynogen/pix-runtime";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { once } from "@xynogen/pix-runtime/once";
import { Type } from "typebox";
import { normalizeCode, resolvePython, runPython } from "./lib.ts";

const TOOL = "python_run";
/** Card title. The tool id stays `python_run`; users read the language. */
const LABEL = "python";
/** Code rows shown on the call card before `… +N lines` (expand shows all). */
const PREVIEW_CODE_LINES = 16;
const PROMPT_TIMEOUT_MS = 60_000;

type Outcome = "awaiting-approval" | "running" | "success" | "error" | "denied";

export interface PythonResultDetails {
	_type: "pythonResult";
	intent: string;
	code: string;
	/** Interpreter that ran (omitted for the default `python3`). */
	python?: string;
	outcome: Outcome;
	exitCode?: number | null;
	lineCount?: number;
	durationMs?: number;
	/** Resolved interpreter path or name, for the status line. */
	interpreter?: string;
	stdout?: string;
	stderr?: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const trimBlank = (s: string) => normalizeLineEndings(s).replace(/^\n+|\n+$/g, "");

type CodeSlot = { key: string; rows?: string[] };

/**
 * Call card: `○ python <intent> (venv)` then the code in pix-pretty's code
 * viewer (the `read` look: rules, line-number gutter, highlighting). Numbers
 * match traceback lines: the viewer shows exactly the normalized script.
 * Rendering is async and cached per width; plain dim lines until it lands.
 */
function codeCard(
	header: string,
	code: string,
	theme: ThemeLike,
	state: Record<string, unknown>,
	invalidate: () => void,
	expanded: boolean,
) {
	let replacement: string | undefined;
	return {
		setText(value: string) {
			replacement = value;
		},
		invalidate() {},
		render(width: number): string[] {
			if (replacement !== undefined)
				return replacement ? new Text(replacement, 0, 0).render(width) : [];
			const head = truncateToWidth(header, width, "…");
			if (!code) return [head];
			const key = `${width}:${expanded}:${code}`;
			let slot = state.pythonCode as CodeSlot | undefined;
			if (slot?.key !== key) {
				const pending: CodeSlot = { key };
				state.pythonCode = slot = pending;
				const lines = code.split("\n").length;
				void renderFileContent(
					code,
					"snippet.py",
					1,
					expanded ? lines : PREVIEW_CODE_LINES,
					theme,
					{
						width,
						wrapLongLines: expanded,
					},
				).then(
					(out) => {
						if (state.pythonCode !== pending) return;
						pending.rows = out.split("\n");
						invalidate();
					},
					() => {
						/* The plain fallback below stays. */
					},
				);
			}
			const body =
				slot.rows ??
				code
					.split("\n")
					.slice(0, expanded ? undefined : PREVIEW_CODE_LINES)
					.map((l) => truncateToWidth(`${BODY_PAD}${theme.fg("dim", l)}`, width, "…"));
			return [head, ...body];
		},
	};
}

export default function pixPython(pi: ExtensionAPI): void {
	once(pi, "pix-python", () => register(pi));
}

function register(pi: ExtensionAPI): void {
	// Pi hands every new session a fresh `pi`, so this resets per session.
	let sessionAllowed = false;

	pi.registerTool({
		name: TOOL,
		...({ exposure: "deferred" } as const),
		label: "Run Python",
		description:
			"Run a Python 3 snippet on the local machine (not sandboxed, session cwd) and return stdout/stderr. " +
			"Use it instead of `python3 -c` or `python3 - <<EOF` in bash. Write plain code: tabs, CRLF, " +
			"markdown fences and a shared indent are repaired. print() what you need. The user approves each run. " +
			"Set `python` only when the project needs a specific interpreter (e.g. its `.venv`).",
		promptSnippet: "Run a Python snippet locally",
		promptGuidelines: [
			"python_run: Python computation/data work instead of `python -c`/heredoc in bash. Set `intent` to a short why.",
		],
		renderShell: "self",
		parameters: Type.Object({
			intent: Type.String({ description: "Short plain-English purpose, shown to the user." }),
			code: Type.String({ description: "Python 3 source. Runs as a script; print() results." }),
			python: Type.Optional(
				Type.String({
					description:
						"Interpreter. Omit for python3 on PATH. A venv/conda folder ('.venv'), an interpreter path, or a name ('python3.12'). Relative to cwd.",
				}),
			),
		}),

		async execute(_id, params, signal, onUpdate, ctx) {
			const intent = oneLine(params.intent) || "(no intent)";
			const code = normalizeCode(params.code);
			const python = params.python?.trim() || undefined;
			const details = (outcome: Outcome, extra: Partial<PythonResultDetails> = {}) =>
				({
					_type: "pythonResult",
					intent,
					code,
					...(python ? { python } : {}),
					outcome,
					...extra,
				}) satisfies PythonResultDetails;
			const update = (outcome: "awaiting-approval" | "running", text: string) =>
				(onUpdate as AgentToolUpdateCallback<PythonResultDetails> | undefined)?.({
					content: [{ type: "text", text }],
					details: details(outcome),
				});
			const deny = (why: string, isError = false) => ({
				content: [{ type: "text" as const, text: `python_run not run: ${why}` }],
				details: details(isError ? "error" : "denied"),
				isError,
			});

			if (!code) return deny("empty code", true);
			let interpreter: string;
			try {
				interpreter = resolvePython(python, ctx.cwd);
			} catch (err) {
				return deny(getErrorMessage(err), true);
			}

			const mode = getUnattendedMode(pi.events);
			if (!sessionAllowed && mode !== "yolo") {
				if (mode === "afk")
					return deny("AFK mode is active and python_run is not allowed this session.");
				if (!ctx.hasUI) return deny("approval needs an interactive session.", true);
				update("awaiting-approval", "Awaiting approval…");
				const choice = await withAgentBlock(pi.events, TOOL, "Python approval required", () =>
					showOverlay(ctx.ui, {
						mode: "confirm",
						icon: icon("process"),
						title: "Run Python",
						accent: "warning",
						timeoutMs: PROMPT_TIMEOUT_MS,
						approveValue: ["yes", "session"],
						body: [
							`Intent: ${intent}`,
							`Cwd: ${ctx.cwd}`,
							...(python ? [`Python: ${interpreter}`] : []),
							"",
							...code.split("\n"),
						],
						choices: [
							{ value: "yes", label: "Allow", description: "Run this snippet" },
							{
								value: "session",
								label: "Allow for this session",
								description: "Stop asking until /new",
							},
							{ value: "no", label: "Deny", description: "Do not run it" },
						],
					}),
				);
				if (choice.action === "timeout") return deny("approval timed out.");
				if (choice.action !== "approved") return deny("denied by user.");
				if (choice.choice === "session") sessionAllowed = true;
			}

			update("running", "Running…");
			const startedAt = Date.now();
			let run: Awaited<ReturnType<typeof runPython>>;
			try {
				run = await runPython(code, ctx.cwd, signal, interpreter);
			} catch (err) {
				return {
					content: [{ type: "text", text: `python_run failed: ${getErrorMessage(err)}` }],
					details: details("error"),
					isError: true,
				};
			}
			const durationMs = Date.now() - startedAt;
			const stdout = trimBlank(run.stdout);
			const stderr = trimBlank(run.stderr);
			const out = [stdout, stderr].filter(Boolean).join("\n");
			// Tracebacks end the output, so keep the tail.
			const t = truncateTail(out || "(no output)", {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const status = run.timedOut ? "killed" : `Exit code: ${run.code}`;
			const note = t.truncated
				? `\n[Output truncated: last ${t.outputLines} of ${t.totalLines} lines]`
				: "";
			const ok = run.code === 0;
			return {
				content: [{ type: "text", text: `${status}\n\n${t.content}${note}` }],
				details: details(ok ? "success" : "error", {
					exitCode: run.code,
					lineCount: out ? out.split("\n").length : 0,
					durationMs,
					interpreter,
					stdout,
					stderr,
				}),
				isError: !ok,
			};
		},

		renderCall: ((
			args: { intent?: string; code?: string; python?: string },
			theme: ThemeLike,
			rc: RenderContextLike,
		) => {
			resolveBaseBackground(theme);
			const text = rc.lastComponent ?? new Text("", 0, 0);
			if (hideCollapsedToolCall(rc.state as CollapseState, rc.expanded, (v) => text.setText(v)))
				return text;
			const intent = oneLine(args.intent ?? "");
			const py = args.python?.trim() ? ` ${theme.fg("muted", `(${args.python.trim()})`)}` : "";
			const header = `${formatToolCallTitle(theme, LABEL, rc)}${intent ? ` ${theme.fg("dim", intent)}` : ""}${py}`;
			// While the model streams `code`, show one stable row; render the viewer once at the end.
			if (rc.argsComplete === false) {
				const n = (args.code ?? "").split("\n").length;
				text.setText(
					`${header} ${theme.fg("muted", `· writing ${n} ${n === 1 ? "line" : "lines"}…`)}`,
				);
				return text;
			}
			return codeCard(
				header,
				normalizeCode(args.code ?? ""),
				theme,
				rc.state,
				rc.invalidate,
				rc.expanded,
			);
		}) as never,

		renderResult: ((
			result: ToolResultLike,
			opt: unknown,
			theme: ThemeLike,
			rc: RenderContextLike,
		) => {
			resolveBaseBackground(theme);
			const text = unframeToolResult(rc.lastComponent ?? new Text("", 0, 0));
			const d = result.details as PythonResultDetails | undefined;
			const isPartial = (opt as { isPartial?: boolean } | undefined)?.isPartial === true;
			const done = (isError: boolean) => (isPartial ? text : frameToolResult(text, theme, isError));

			if (d?._type !== "pythonResult") {
				const msg = getTextContent(result) || (rc.isError ? "Error" : "done");
				text.setText(
					rc.isError
						? renderToolError(msg, theme)
						: fillToolBackground(`${BODY_PAD}${theme.fg("muted", msg)}`),
				);
				return done(rc.isError);
			}

			if (d.outcome === "awaiting-approval" || d.outcome === "running") {
				text.setText(fillToolBackground(`${BODY_PAD}${theme.fg("muted", getTextContent(result))}`));
				return text;
			}

			const ok = d.outcome === "success";
			if (!isPartial && tickCollapse(TOOL, rc.state as CollapseState, rc.invalidate, rc.expanded)) {
				const ms = Number(rc.durationMs ?? d.durationMs ?? 0);
				const meta = dotJoin([
					d.outcome === "denied" && "not run",
					typeof d.exitCode === "number" && d.exitCode !== 0 && `exit ${d.exitCode}`,
					d.exitCode === null && "killed",
					!!d.lineCount && `${d.lineCount} ${d.lineCount === 1 ? "line" : "lines"}`,
					ms > 0 && formatDuration(ms, "bash"),
				]);
				const status = ok ? "success" : d.outcome === "denied" ? "warning" : "error";
				return collapsedCommandRow(
					formatCollapsedToolRow(theme, LABEL, "", meta, status).trimEnd(),
					d.intent,
					theme,
				);
			}

			if (d.stdout === undefined) {
				const msg = getTextContent(result) || "Error";
				text.setText(
					d.outcome === "denied"
						? fillToolBackground(`${BODY_PAD}${theme.fg("warning", msg)}`)
						: renderToolError(msg, theme),
				);
				return done(true);
			}

			// stdout plain, stderr in the status color (warnings on success, red on failure).
			const errRole = ok ? "warning" : "error";
			const lines = [
				...(d.stdout ? d.stdout.split("\n").map((l) => bodyLine(l, theme)) : []),
				...(d.stderr ? d.stderr.split("\n").map((l) => `${BODY_PAD}${theme.fg(errRole, l)}`) : []),
			];
			if (!lines.length) lines.push(`${BODY_PAD}${theme.fg("muted", "(no output)")}`);
			const max = rc.expanded ? lines.length : MAX_PREVIEW_LINES;
			// Keep the tail: the traceback and the final prints are what matter.
			const body = lines.slice(-max);
			const hidden = lines.length - body.length;
			const ms = Number(rc.durationMs ?? d.durationMs ?? 0);
			const status = dotJoin([
				d.exitCode === null ? "killed" : `exit ${d.exitCode}`,
				ms > 0 && formatDuration(ms, "bash"),
				d.interpreter && d.interpreter !== "python3" && d.interpreter,
			]);
			const rows = [
				...(hidden > 0 ? [moreLines(hidden, theme).replace("more", "earlier")] : []),
				...body,
				`${BODY_PAD}${theme.fg(ok ? "success" : "error", d.exitCode === null ? "⚡" : ok ? "✓" : "✗")} ${theme.fg("muted", status)}`,
			];
			text.setText(fillToolBackground(rows.join("\n")));
			return done(!ok);
		}) as never,
	});
}
