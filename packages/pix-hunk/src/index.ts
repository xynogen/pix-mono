import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	dotJoin,
	formatCollapsedToolRow,
	frameToolResult,
	hideCollapsedToolCall,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { Type } from "typebox";
import {
	buildHunkArgs,
	type CommentType,
	type HighlightTone,
	type HunkAction,
	type HunkOp,
} from "./lib.ts";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MODEL_CHARS = 10_000;

export interface HunkRunResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type HunkRunner = (args: string[], signal?: AbortSignal) => Promise<HunkRunResult>;

export const runHunk: HunkRunner = (args, signal) =>
	new Promise((resolve, reject) => {
		execFile("hunk", args, { maxBuffer: MAX_OUTPUT_BYTES, signal }, (error, stdout, stderr) => {
			if (error && signal?.aborted) {
				reject(error);
				return;
			}
			resolve({
				stdout,
				stderr: stderr || error?.message || "",
				code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
			});
		});
	});

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface HunkOperationResult {
	action: HunkAction;
	ok: boolean;
	data?: JsonValue;
	error?: string;
}

interface HunkResultDetails {
	_type: "hunkResult";
	outcome: "success" | "error";
	results: HunkOperationResult[];
}

type HunkTheme = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

function parseOutput(text: string): JsonValue {
	const trimmed = text.trim();
	if (!trimmed) return {};
	try {
		return JSON.parse(trimmed) as JsonValue;
	} catch {
		return trimmed;
	}
}

const ActionSchema = Type.Enum(
	[
		"list",
		"get",
		"context",
		"review",
		"navigate",
		"comment",
		"comment_list",
		"comment_rm",
		"highlight",
		"highlight_clear",
		"reload",
	] as const,
	{ type: "string" },
);

const OpSchema = Type.Object({
	action: ActionSchema,
	repo: Type.Optional(Type.String({ description: "Session repo root (default: cwd)." })),
	sessionId: Type.Optional(Type.String({ description: "Exact session id." })),
	file: Type.Optional(Type.String({ description: "File path within the review." })),
	hunk: Type.Optional(Type.Integer({ minimum: 1, description: "1-based hunk index." })),
	newLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-based new-side line." })),
	oldLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-based old-side line." })),
	summary: Type.Optional(Type.String({ description: "Inline comment summary." })),
	rationale: Type.Optional(Type.String({ description: "Inline comment rationale." })),
	commentId: Type.Optional(Type.String({ description: "Comment id to remove." })),
	type: Type.Optional(
		Type.Enum(["live", "all", "ai", "agent", "user"] as const, {
			type: "string",
			description: "Comment-list filter.",
		}),
	),
	start: Type.Optional(Type.Integer({ minimum: 0, description: "Highlight start offset." })),
	end: Type.Optional(Type.Integer({ minimum: 1, description: "Highlight end offset." })),
	tone: Type.Optional(
		Type.Enum(["match", "info", "warning", "error", "current"] as const, {
			type: "string",
		}),
	),
	nextComment: Type.Optional(Type.Boolean()),
	prevComment: Type.Optional(Type.Boolean()),
	includePatch: Type.Optional(Type.Boolean()),
	focus: Type.Optional(Type.Boolean()),
	reloadArgs: Type.Optional(
		Type.Array(Type.String(), { description: 'Reload command, e.g. ["diff","main...HEAD"].' }),
	),
});

type ToolOp = HunkOp & { type?: CommentType; tone?: HighlightTone };

type JsonObject = { [key: string]: JsonValue };

function object(value: JsonValue | undefined): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function string(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function number(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function array(value: JsonValue | undefined): JsonValue[] {
	return Array.isArray(value) ? value : [];
}

function range(value: JsonValue | undefined): string | undefined {
	const values = array(value);
	const start = number(values[0]);
	const end = number(values[1]);
	return start !== undefined && end !== undefined ? `${start}-${end}` : undefined;
}

function boolean(value: JsonValue | undefined): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function inline(value: string | undefined, fallback = "-"): string {
	return value?.replace(/\s+/g, " ").trim() || fallback;
}

function selection(file: string | undefined, hunk: number | undefined): string {
	return file ? `${inline(file)}${hunk === undefined ? "" : `:h${hunk + 1}`}` : "none";
}

function ranges(value: JsonObject | undefined): string {
	const oldRange = range(value?.oldRange);
	const newRange = range(value?.newRange);
	return [oldRange && `old=${oldRange}`, newRange && `new=${newRange}`].filter(Boolean).join(" ");
}

function formatList(data: JsonObject): string[] {
	const sessions = array(data.sessions);
	if (sessions.length === 0) return ["list sessions=0"];
	const lines = ["list"];
	for (const rawSession of sessions) {
		const session = object(rawSession);
		if (!session) continue;
		const state = object(object(object(session.snapshot)?.state));
		const selected = selection(string(state?.selectedFilePath), number(state?.selectedHunkIndex));
		lines.push(
			`  ${inline(string(session.sessionId))} ${inline(string(session.title), "")}`.trimEnd(),
			`    repo=${inline(string(session.repoRoot) ?? string(session.cwd))} selected=${selected} files=${number(session.fileCount) ?? array(session.files).length} comments=${number(state?.liveCommentCount) ?? 0}`,
		);
	}
	return lines;
}

function formatGet(data: JsonObject): string[] {
	const session = object(data.session) ?? data;
	const state = object(object(object(session.snapshot)?.state));
	return [
		`get ${inline(string(session.sessionId))} ${inline(string(session.title), "")}`.trimEnd(),
		`  cwd=${inline(string(session.cwd))} repo=${inline(string(session.repoRoot))} source=${inline(string(session.sourceLabel))}`,
		`  selected ${selection(string(state?.selectedFilePath), number(state?.selectedHunkIndex))}`,
	];
}

function formatContext(data: JsonObject): string[] {
	const context = object(data.context) ?? data;
	const selectedFile = object(context.selectedFile);
	const selectedHunk = object(context.selectedHunk);
	const detail = ranges(selectedHunk);
	return [
		`context ${inline(string(context.sessionId))} ${inline(string(context.title), "")}`.trimEnd(),
		`  selected ${selection(string(selectedFile?.path), number(selectedHunk?.index))}${detail ? ` ${detail}` : ""} comments=${number(context.liveCommentCount) ?? 0}`,
	];
}

function formatReview(data: JsonObject): string[] {
	const review = object(data.review) ?? data;
	const selectedFile = object(review.selectedFile);
	const selectedHunk = object(review.selectedHunk);
	const sessionId = string(review.sessionId);
	const lines = [
		`review${sessionId ? ` ${inline(sessionId)}` : ""} ${inline(string(review.title), "live review")}`,
		`  selected ${selection(string(selectedFile?.path), number(selectedHunk?.index))}`,
	];
	for (const rawFile of array(review.files)) {
		const file = object(rawFile);
		if (!file) continue;
		lines.push(
			`  ${inline(string(file.path), "(unknown file)")} +${number(file.additions) ?? 0} -${number(file.deletions) ?? 0}`,
		);
		for (const rawHunk of array(file.hunks)) {
			const hunk = object(rawHunk);
			if (!hunk) continue;
			const detail = ranges(hunk);
			lines.push(`    h${(number(hunk.index) ?? 0) + 1}${detail ? ` ${detail}` : ""}`);
		}
		const patch = string(file.patch);
		if (patch) lines.push("    patch", ...patch.split("\n").map((line) => `      ${line}`));
	}
	return lines;
}

function target(result: JsonObject): string {
	const file = inline(string(result.filePath), "(unknown file)");
	const side = string(result.side);
	const line = number(result.line);
	const location = side && line !== undefined ? `${file}:${side}:${line}` : file;
	const hunk = number(result.hunkIndex);
	return `${location}${hunk === undefined ? "" : ` h${hunk + 1}`}`;
}

function formatComment(data: JsonObject): string[] {
	const result = object(data.result) ?? data;
	return [`comment ${inline(string(result.commentId))} ${target(result)}`];
}

function noteTarget(comment: JsonObject): string {
	const file = inline(string(comment.filePath), "(unknown file)");
	const hunk = number(comment.hunkIndex);
	const suffix = hunk === undefined ? "" : ` h${hunk + 1}`;
	const oldRange = array(comment.oldRange);
	const newRange = array(comment.newRange);
	const oldStart = number(oldRange[0]);
	const oldEnd = number(oldRange[1]);
	const newStart = number(newRange[0]);
	const newEnd = number(newRange[1]);
	if (newStart !== undefined && newStart === newEnd && oldStart === undefined) {
		return `${file}:new:${newStart}${suffix}`;
	}
	if (oldStart !== undefined && oldStart === oldEnd && newStart === undefined) {
		return `${file}:old:${oldStart}${suffix}`;
	}
	const detail = ranges(comment);
	return `${file}${suffix}${detail ? ` ${detail}` : ""}`;
}

function formatCommentList(data: JsonObject): string[] {
	const comments = array(data.comments);
	if (comments.length === 0) return ["comment_list none"];
	const lines = ["comment_list"];
	for (const rawComment of comments) {
		const comment = object(rawComment);
		if (!comment) continue;
		const id = inline(string(comment.commentId) ?? string(comment.noteId));
		const detail = target(comment);
		const location = string(comment.side) ? detail : noteTarget(comment);
		const author = string(comment.author);
		const body = string(comment.summary) ?? string(comment.body) ?? "";
		const prefix = `${id} ${location}${author ? ` @${inline(author)}` : ""}:`;
		const bodyLines = body.split(/\r?\n/);
		lines.push(`${prefix} ${bodyLines[0] ?? ""}`.trimEnd());
		lines.push(...bodyLines.slice(1).map((line) => `  ${line}`));
	}
	return lines;
}

function formatResultAction(action: HunkAction, data: JsonObject, op: ToolOp): string[] {
	const result = object(data.result) ?? data;
	switch (action) {
		case "list":
			return formatList(data);
		case "get":
			return formatGet(data);
		case "context":
			return formatContext(data);
		case "review":
			return formatReview(data);
		case "navigate": {
			const detail = ranges(object(result.selectedHunk));
			return [
				`navigate ${selection(string(result.filePath), number(result.hunkIndex))}${detail ? ` ${detail}` : ""}`,
			];
		}
		case "comment":
			return formatComment(data);
		case "comment_list":
			return formatCommentList(data);
		case "comment_rm":
			return [
				`comment_rm ${inline(string(result.commentId) ?? op.commentId)}${boolean(result.removed) === false ? " removed=false" : ""} remaining=${number(result.remainingCommentCount) ?? "-"}`,
			];
		case "highlight": {
			const side = op.newLine === undefined ? "old" : "new";
			const line = op.newLine ?? op.oldLine;
			return [
				`highlight ${inline(op.file)}:${side}:${line ?? "-"} chars=${op.start}-${op.end}${op.tone ? ` tone=${op.tone}` : ""}${op.focus ? " focus" : ""}`,
			];
		}
		case "highlight_clear":
			return [`highlight_clear ${op.file ? inline(op.file) : "session"}`];
		case "reload":
			return [
				`reload ${inline(string(result.title))} files=${number(result.fileCount) ?? 0} selected=${selection(string(result.selectedFilePath), number(result.selectedHunkIndex))}`,
			];
	}
}

function formatOperation(result: HunkOperationResult, op: ToolOp): string {
	if (!result.ok) return `${result.action} error: ${result.error ?? "failed"}`;
	const data = object(result.data);
	return data
		? formatResultAction(result.action, data, op).join("\n")
		: `${result.action} complete`;
}

function truncateRecord(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const marker = "\n  [truncated; full result in tool details]";
	const header = text.split("\n", 1)[0] ?? text;
	if (header.length + marker.length > limit) return header.slice(0, limit);
	return `${text.slice(0, limit - marker.length).trimEnd()}${marker}`;
}

function modelText(results: HunkOperationResult[], ops: ToolOp[], maxCharacters: number): string {
	const separators = Math.max(0, results.length - 1);
	const available = maxCharacters - separators;
	const quota = Math.floor(available / results.length);
	let remainder = available % results.length;
	return results
		.map((result, index) => {
			const limit = quota + (remainder-- > 0 ? 1 : 0);
			return truncateRecord(
				formatOperation(result, ops[index] ?? { action: result.action }),
				limit,
			);
		})
		.join("\n");
}

function executionError(run: HunkRunResult): string {
	const raw = (run.stderr || run.stdout || `hunk exited ${run.code}`).trim();
	return /(?:^|\s)(?:spawn\s+)?hunk\s+ENOENT(?:\s|$)/i.test(raw)
		? "Hunk CLI not found. Install Hunk, launch a review session, then retry."
		: raw;
}

function actionSummary(actions: HunkAction[]): string {
	if (actions.length === 0) return "empty";
	return `${actions[0]}${actions.length > 1 ? ` +${actions.length - 1}` : ""}`;
}

function listedCommentCount(result: HunkOperationResult): number | undefined {
	if (result.action !== "comment_list" || !result.ok) return undefined;
	return array(object(result.data)?.comments).length;
}

function commentCount(results: HunkOperationResult[]): number {
	const listed = results.map(listedCommentCount).find((count) => count !== undefined);
	return listed ?? results.filter((result) => result.action === "comment" && result.ok).length;
}

function renderSummary(details: HunkResultDetails, theme: HunkTheme): string {
	const actions = details.results.map((result) => result.action);
	const comments = commentCount(details.results);
	const meta = dotJoin([
		`${details.results.length} ops`,
		comments > 0 && `${comments} comment${comments === 1 ? "" : "s"}`,
	]);
	return formatCollapsedToolRow(
		theme,
		"hunk",
		actionSummary(actions),
		meta,
		details.outcome === "error" ? "error" : "success",
	);
}

function resultTarget(result: HunkOperationResult): string {
	const data = object(result.data);
	const value = object(data?.result) ?? data;
	if (!value) return result.ok ? "complete" : (result.error ?? "failed");
	if (result.action === "comment_list") {
		const count = array(data?.comments).length;
		return count === 0 ? "none" : `${count} comment${count === 1 ? "" : "s"}`;
	}
	if (result.action === "list") return `sessions=${array(data?.sessions).length}`;
	if (result.action === "comment_rm") {
		return `remaining=${number(value.remainingCommentCount) ?? "-"}`;
	}
	const file = string(value.filePath) ?? string(object(value.selectedFile)?.path);
	const hunk = number(value.hunkIndex) ?? number(object(value.selectedHunk)?.index);
	const side = string(value.side);
	const line = number(value.line);
	if (file && side && line !== undefined) {
		return `${file}:${side}:${line}${hunk === undefined ? "" : ` h${hunk + 1}`}`;
	}
	if (file) return selection(file, hunk);
	return "complete";
}

function renderExpanded(details: HunkResultDetails, theme: HunkTheme): string {
	const targetResult =
		details.results.find((result) => result.ok && result.action === "navigate") ??
		details.results.find(
			(result) => result.ok && !["comment_list", "comment_rm"].includes(result.action),
		);
	const target = targetResult ? resultTarget(targetResult) : "complete";
	const comments = commentCount(details.results);
	const meta = comments > 0 ? `${comments} comment${comments === 1 ? "" : "s"}` : "";
	const summary = `${theme.fg("dim", target)}${meta ? ` ${theme.fg("muted", `· ${meta}`)}` : ""}`;
	const errors = details.results
		.filter((result) => !result.ok)
		.map((result) => theme.fg("error", `${result.action}: ${result.error ?? "failed"}`));
	return [summary, ...errors].join("\n");
}

export default function registerHunk(pi: ExtensionAPI, runner: HunkRunner = runHunk): void {
	pi.registerTool({
		name: "hunk",
		label: "Hunk",
		renderShell: "self",
		description:
			"Drive a live Hunk diff review through `hunk session *`. Runs ordered `ops` in one call and returns every result. Supports inspection, navigation, comments, highlights, and reload. Never launches the interactive TUI.",
		promptSnippet: "Drive a live Hunk diff review with an ordered batch of session operations",
		promptGuidelines: [
			"hunk: start with `review` (raw patch only via `includePatch:true`); use `navigate`, `comment`, and `highlight` to guide the live review. If no session exists, ask the user to launch Hunk.",
		],
		parameters: Type.Object({
			ops: Type.Array(OpSchema, {
				minItems: 1,
				maxItems: 20,
				description: "Operations executed in order; all results are returned.",
			}),
			maxCharacters: Type.Optional(
				Type.Integer({
					minimum: 1_000,
					maximum: 50_000,
					description: "Maximum model-facing result characters (default 10000).",
				}),
			),
		}),
		renderCall(args, theme, context) {
			const text = new Text("", 0, 0);
			if (
				hideCollapsedToolCall(context.state as CollapseState, context.expanded, (value) =>
					text.setText(value),
				)
			)
				return text;
			const actions = ((args as { ops?: ToolOp[] }).ops ?? []).map((op) => op.action);
			text.setText(
				`${theme.fg("toolTitle", theme.bold("hunk"))} ${theme.fg("dim", actionSummary(actions))}`,
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = new Text("", 0, 0);
			const details = result.details as HunkResultDetails | undefined;
			if (!details) {
				text.setText(
					result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
				);
				return text;
			}
			const collapsed = tickCollapse(
				"hunk",
				context.state as CollapseState,
				context.invalidate,
				options.expanded,
			);
			if (collapsed) {
				text.setText(renderSummary(details, theme as HunkTheme));
				return text;
			}
			text.setText(renderExpanded(details, theme as HunkTheme));
			return options.isPartial
				? text
				: frameToolResult(text, theme, context.isError || details.outcome === "error");
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const ops = params.ops as ToolOp[];
			const results: HunkOperationResult[] = [];
			for (const op of ops) {
				try {
					const run = await runner(buildHunkArgs(op, ctx.cwd), signal);
					results.push(
						run.code === 0
							? { action: op.action, ok: true, data: parseOutput(run.stdout || run.stderr) }
							: { action: op.action, ok: false, error: executionError(run) },
					);
				} catch (error) {
					if (signal?.aborted) throw error;
					results.push({
						action: op.action,
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			const details: HunkResultDetails = {
				_type: "hunkResult",
				outcome: results.every((result) => result.ok) ? "success" : "error",
				results,
			};
			return {
				content: [
					{
						type: "text" as const,
						text: modelText(results, ops, params.maxCharacters ?? DEFAULT_MODEL_CHARS),
					},
				],
				details,
			};
		},
	});
}
