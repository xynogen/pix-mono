import { describe, expect, test } from "bun:test";
import registerToolsNudge, {
	classify,
	classifyCompound,
	nudgeReason,
	splitSegments,
} from "./tools.ts";

/** Minimal fakes for the bits of ExtensionAPI / ctx the handler touches. */
type ToolCallHandler = (
	event: unknown,
	ctx: { ui: { notify: (msg: string, type?: string) => void } },
) => Promise<unknown> | unknown;

function makeHandler(
	activeTools: string[] = ["read", "ls", "grep", "find", "edit"],
	registeredTools: string[] = ["read", "ls", "grep", "find", "edit", "ssh_run", "sudo_run"],
): ToolCallHandler {
	let handler: ToolCallHandler | undefined;
	const pi = {
		on(eventName: string, h: ToolCallHandler) {
			if (eventName === "tool_call") handler = h;
		},
		getActiveTools: () => activeTools,
		getAllTools: () => registeredTools.map((name) => ({ name })),
	};
	registerToolsNudge(pi as unknown as Parameters<typeof registerToolsNudge>[0]);
	if (!handler) throw new Error("handler not registered");
	return handler;
}

function bashEvent(command: string) {
	return { toolName: "bash", input: { command } };
}

function makeCtx() {
	const notices: Array<{ msg: string; type?: string }> = [];
	return {
		ctx: {
			ui: {
				notify: (msg: string, type?: string) => notices.push({ msg, type }),
			},
		},
		notices,
	};
}

describe("classify", () => {
	test("maps cat/head/tail/less to read", () => {
		for (const c of ["cat foo.ts", "head -5 a", "tail -f log", "less x"]) {
			expect(classify(c)?.category).toBe("read");
		}
	});

	test("maps ls/tree to ls", () => {
		expect(classify("ls -la")?.category).toBe("ls");
		expect(classify("tree src")?.category).toBe("ls");
	});

	test("maps grep/rg to grep", () => {
		expect(classify("grep foo bar.ts")?.category).toBe("grep");
		expect(classify("rg pattern")?.category).toBe("grep");
	});

	test("maps find/fd to find", () => {
		expect(classify("find . -name x")?.category).toBe("find");
		expect(classify("fd '*.ts'")?.category).toBe("find");
	});

	test("maps sed -i to edit, but plain sed is allowed", () => {
		expect(classify("sed -i 's/a/b/' f")?.category).toBe("edit");
		expect(classify("sed 's/a/b/' f")).toBeUndefined();
	});

	test("strips env-var prefix before matching", () => {
		expect(classify("FOO=bar grep x y")?.category).toBe("grep");
	});

	test("unaliases leading backslash", () => {
		expect(classify("\\grep x y")?.category).toBe("grep");
	});

	test("ignores compound / piped / redirected commands", () => {
		expect(classify("cat a | grep b")).toBeUndefined();
		expect(classify("grep x y > out")).toBeUndefined();
		expect(classify("ls && echo done")).toBeUndefined();
		expect(classify("cat $(ls)")).toBeUndefined();
		expect(classify("ls; pwd")).toBeUndefined();
	});

	test("ignores non-tool commands and empty input", () => {
		expect(classify("git status")).toBeUndefined();
		expect(classify("npm test")).toBeUndefined();
		expect(classify("")).toBeUndefined();
		expect(classify("   ")).toBeUndefined();
	});
});

describe("splitSegments", () => {
	test("records the operator following each segment", () => {
		expect(splitSegments("cat x | jq .")).toEqual([
			{ text: "cat x ", followedBy: "|" },
			{ text: " jq .", followedBy: "" },
		]);
		expect(splitSegments("cat x || ls y")).toEqual([
			{ text: "cat x ", followedBy: "||" },
			{ text: " ls y", followedBy: "" },
		]);
	});

	test("drops empty segments", () => {
		expect(splitSegments("ls;")).toEqual([{ text: "ls", followedBy: ";" }]);
	});
});

describe("classifyCompound", () => {
	test("still classifies simple commands", () => {
		expect(classifyCompound("cat foo")?.category).toBe("read");
		expect(classifyCompound("git status")).toBeUndefined();
	});

	test("catches the chaining-dodge (|| && ;)", () => {
		// seg1 `cat x 2>/dev/null` has a redirect (opaque per-segment); seg2
		// `ls -la` is a clean stand-in — still nudged, as `ls`.
		expect(classifyCompound("cat x 2>/dev/null || ls -la")?.category).toBe("ls");
		// Pure clean read stand-in chained with another clean cmd.
		expect(classifyCompound("cat x || ls -la")?.category).toBe("read");
		expect(classifyCompound("ls -la && echo done")?.category).toBe("ls");
		expect(classifyCompound("ls; pwd")?.category).toBe("ls");
		expect(classifyCompound("true && grep foo bar.ts")?.category).toBe("grep");
	});

	test("exempts a segment that feeds a pipe (legit producer)", () => {
		expect(classifyCompound("cat x | jq .")).toBeUndefined();
		expect(classifyCompound("grep foo a | head")).toBeUndefined();
	});

	test("exempts redirects per-segment", () => {
		expect(classifyCompound("grep x y > out")).toBeUndefined();
	});

	test("exempts when no segment is a leading stand-in", () => {
		expect(classifyCompound("git log | cat")).toBeUndefined();
		expect(classifyCompound("npm test && npm run build")).toBeUndefined();
	});

	test("empty / whitespace", () => {
		expect(classifyCompound("")).toBeUndefined();
		expect(classifyCompound("   ")).toBeUndefined();
	});
});

describe("nudgeReason", () => {
	test("active tool: point straight at it, no toolbox", () => {
		const msg = nudgeReason("Searching file contents via bash grep/rg.", "grep", true);
		expect(msg).toContain("Use `grep` instead");
		expect(msg).toContain("function definitions");
		expect(msg).not.toContain("toolbox");
	});

	test("gated tool: route through toolbox enable, not a direct call", () => {
		const msg = nudgeReason("Listing a directory via bash ls/tree.", "ls", false);
		expect(msg).toContain('toolbox(action:"enable", name:"ls")');
		expect(msg).toContain("prompt-hidden");
		expect(msg).toContain("function definitions");
		// Must NOT imply the tool is directly callable by name (it's prompt-hidden).
		expect(msg).not.toContain("Use `ls` instead");
	});

	test("gated find tool names itself in the enable hint", () => {
		expect(nudgeReason("Locating files via bash find/fd.", "find", false)).toContain(
			'toolbox(action:"enable", name:"find")',
		);
	});

	test("is a single short line — no inventory dump, no newlines", () => {
		const msg = nudgeReason("Listing a directory via bash ls/tree.", "ls", false);
		expect(msg).not.toContain("\n");
		expect(msg).not.toContain("Available tools");
		expect(msg.length).toBeLessThan(400);
	});
});

describe("registerToolsNudge handler", () => {
	type Notice = { msg: string; type?: string };
	test("warns yellow and does NOT block the command", async () => {
		const handler = makeHandler();
		const { ctx, notices } = makeCtx();

		const result = await handler(bashEvent("cat foo.ts"), ctx);

		// Non-blocking: returns nothing, so the command proceeds.
		expect(result).toBeUndefined();
		// Surfaced as a single yellow warning.
		expect(notices).toHaveLength(1);
		const n0 = notices[0] as Notice;
		expect(n0.type).toBe("warning");
		expect(n0.msg).toContain("Use `read` instead");
	});

	test("warns once per category, silent thereafter", async () => {
		const handler = makeHandler();
		const { ctx, notices } = makeCtx();

		await handler(bashEvent("cat a"), ctx);
		await handler(bashEvent("head b"), ctx); // same `read` category
		expect(notices).toHaveLength(1);

		await handler(bashEvent("grep x y"), ctx); // new category → new warning
		expect(notices).toHaveLength(2);
		expect((notices[1] as Notice).msg).toContain("Use `grep` instead");
	});

	test("ignores commands with no tool stand-in", async () => {
		const handler = makeHandler();
		const { ctx, notices } = makeCtx();

		await handler(bashEvent("git status"), ctx);
		await handler(bashEvent("cat a | grep b"), ctx); // compound — real shell work
		expect(notices).toHaveLength(0);
	});

	test("nudges bash ssh toward ssh_run when it's registered", async () => {
		const handler = makeHandler();
		const { ctx, notices } = makeCtx();

		await handler(bashEvent("ssh deploy@host uptime"), ctx);

		expect(notices).toHaveLength(1);
		expect((notices[0] as Notice).msg).toContain("ssh_run");
	});

	test("stays silent on bash ssh when ssh_run isn't installed", async () => {
		// pix-ssh is opt-in; without it, bash ssh is the only path.
		const handler = makeHandler(
			["read", "ls", "grep", "find", "edit"],
			["read", "ls", "grep", "find", "edit"],
		);
		const { ctx, notices } = makeCtx();

		await handler(bashEvent("ssh deploy@host uptime"), ctx);

		expect(notices).toHaveLength(0);
	});

	test("nudges bash sudo toward sudo_run when it's registered", async () => {
		const handler = makeHandler();
		const { ctx, notices } = makeCtx();

		await handler(bashEvent("sudo apt update"), ctx);

		expect(notices).toHaveLength(1);
		expect((notices[0] as Notice).msg).toContain("sudo_run");
	});

	test("stays silent on bash sudo when sudo_run isn't installed", async () => {
		const handler = makeHandler(
			["read", "ls", "grep", "find", "edit"],
			["read", "ls", "grep", "find", "edit"],
		);
		const { ctx, notices } = makeCtx();

		await handler(bashEvent("sudo apt update"), ctx);

		expect(notices).toHaveLength(0);
	});

	test("gated tool routes through toolbox enable, still non-blocking", async () => {
		const handler = makeHandler([]); // nothing active → all gated
		const { ctx, notices } = makeCtx();

		const result = await handler(bashEvent("ls -la"), ctx);

		expect(result).toBeUndefined();
		const gn0 = notices[0] as Notice;
		expect(gn0.type).toBe("warning");
		expect(gn0.msg).toContain('toolbox(action:"enable", name:"ls")');
	});
});
