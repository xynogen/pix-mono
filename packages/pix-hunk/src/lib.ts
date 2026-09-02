export type HunkAction =
	| "list"
	| "get"
	| "context"
	| "review"
	| "navigate"
	| "comment"
	| "comment_list"
	| "comment_rm"
	| "highlight"
	| "highlight_clear"
	| "reload";

export type CommentType = "live" | "all" | "ai" | "agent" | "user";
export type HighlightTone = "match" | "info" | "warning" | "error" | "current";

export interface HunkOp {
	action: HunkAction;
	repo?: string;
	sessionId?: string;
	file?: string;
	hunk?: number;
	newLine?: number;
	oldLine?: number;
	summary?: string;
	rationale?: string;
	commentId?: string;
	type?: CommentType;
	start?: number;
	end?: number;
	tone?: HighlightTone;
	nextComment?: boolean;
	prevComment?: boolean;
	includePatch?: boolean;
	focus?: boolean;
	reloadArgs?: string[];
}

function selector(op: HunkOp, cwd: string): string[] {
	return op.sessionId ? [op.sessionId] : ["--repo", op.repo ?? cwd];
}

function lineTarget(op: HunkOp): string[] {
	if (op.newLine !== undefined) return ["--new-line", String(op.newLine)];
	if (op.oldLine !== undefined) return ["--old-line", String(op.oldLine)];
	return [];
}

function hasOneLineTarget(op: HunkOp): boolean {
	return (op.newLine !== undefined ? 1 : 0) + (op.oldLine !== undefined ? 1 : 0) === 1;
}

function validateOp(op: HunkOp): void {
	if (op.action === "navigate") {
		const directions = (op.nextComment ? 1 : 0) + (op.prevComment ? 1 : 0);
		if (directions > 1) throw new Error("navigate accepts one comment direction");
		const absoluteTargets =
			(op.hunk !== undefined ? 1 : 0) +
			(op.newLine !== undefined ? 1 : 0) +
			(op.oldLine !== undefined ? 1 : 0);
		if (directions === 0 && (!op.file || absoluteTargets !== 1)) {
			throw new Error("navigate requires file and exactly one navigation target");
		}
	}
	if (op.action === "comment" && (!op.file || !op.summary || !hasOneLineTarget(op))) {
		throw new Error("comment requires file, summary, and exactly one line target");
	}
	if (op.action === "comment_rm" && !op.commentId) {
		throw new Error("comment_rm requires commentId");
	}
	if (op.action === "highlight") {
		if (!op.file || !hasOneLineTarget(op) || op.start === undefined || op.end === undefined) {
			throw new Error("highlight requires file, one line target, start, and end");
		}
		if (op.end <= op.start) throw new Error("highlight end must be greater than start");
	}
}

export function buildHunkArgs(op: HunkOp, cwd: string): string[] {
	validateOp(op);
	const args = ["session"];

	switch (op.action) {
		case "list":
			args.push("list");
			break;
		case "get":
		case "context":
			args.push(op.action, ...selector(op, cwd));
			break;
		case "review":
			args.push("review", ...selector(op, cwd));
			if (op.includePatch) args.push("--include-patch");
			break;
		case "navigate":
			args.push("navigate", ...selector(op, cwd));
			if (op.nextComment) args.push("--next-comment");
			else if (op.prevComment) args.push("--prev-comment");
			else {
				if (op.file) args.push("--file", op.file);
				if (op.hunk !== undefined) args.push("--hunk", String(op.hunk));
				else args.push(...lineTarget(op));
			}
			break;
		case "comment":
			args.push("comment", "add", ...selector(op, cwd));
			if (op.file) args.push("--file", op.file);
			args.push(...lineTarget(op));
			if (op.summary) args.push("--summary", op.summary);
			if (op.rationale) args.push("--rationale", op.rationale);
			if (op.focus) args.push("--focus");
			break;
		case "comment_list":
			args.push("comment", "list", ...selector(op, cwd));
			if (op.file) args.push("--file", op.file);
			if (op.type) args.push("--type", op.type);
			break;
		case "comment_rm":
			args.push("comment", "rm", ...selector(op, cwd));
			if (op.commentId) args.push(op.commentId);
			break;
		case "highlight":
			args.push("highlight", "add", ...selector(op, cwd));
			if (op.file) args.push("--file", op.file);
			args.push(...lineTarget(op));
			if (op.start !== undefined) args.push("--start", String(op.start));
			if (op.end !== undefined) args.push("--end", String(op.end));
			if (op.tone) args.push("--tone", op.tone);
			if (op.focus) args.push("--focus");
			break;
		case "highlight_clear":
			args.push("highlight", "clear", ...selector(op, cwd));
			if (op.file) args.push("--file", op.file);
			break;
		case "reload":
			args.push("reload", ...selector(op, cwd), "--json", "--", ...(op.reloadArgs ?? ["diff"]));
			return args;
	}

	args.push("--json");
	return args;
}
