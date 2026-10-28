import { describe, expect, test } from "bun:test";
import registerToolsNudge, {
	classify,
	classifyCompound,
	nudgeFor,
	nudgeReason,
	splitSegments,
} from "./tools.ts";

/** Minimal fakes for the bits of ExtensionAPI the handler touches. */
type ToolResultHandler = (event: unknown, ctx?: unknown) => unknown;
type Result = { content: Array<{ type: string; text: string }> } | undefined;
type Card = { kind: string; summary: string; body: string };

/** Nudge cards the handler appended, keyed like the old notify list. */
let notices: Array<{ msg: string; type: string }> = [];

const ALL_TOOLS = ["read", "ls", "grep", "find", "edit", "write", "proc", "tool_search"];

function makeHandler(
	activeTools: string[] = ["read", "ls", "grep", "find", "edit", "write", "proc"],
	registered: string[] = ALL_TOOLS,
): ToolResultHandler {
	let handler: ToolResultHandler | undefined;
	const pi = {
		on(eventName: string, h: ToolResultHandler) {
			if (eventName === "tool_result") handler = h;
		},
		getActiveTools: () => activeTools,
		getAllTools: () => registered.map((name) => ({ name })),
		appendEntry: (customType: string, card: Card) =>
			notices.push({ msg: card.body, type: `${customType}:${card.kind}` }),
	};
	registerToolsNudge(pi as unknown as Parameters<typeof registerToolsNudge>[0]);
	if (!handler) throw new Error("handler not registered");
	return handler;
}

function bashEvent(command: string) {
	return { toolName: "bash", input: { command }, content: [{ type: "text", text: "out" }] };
}

function makeCtx() {
	notices = [];
	return { ctx: {}, notices };
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

	test("maps sed -i to edit, sed -n range print to read, other sed is allowed", () => {
		expect(classify("sed -i 's/a/b/' f")?.category).toBe("edit");
		expect(classify("sed -n '10,40p' f.ts")?.category).toBe("read");
		expect(classify("sed 's/a/b/' f")).toBeUndefined();
	});

	test("sees through the rtk wrapper pix-optimizer adds before tool_result", () => {
		expect(classify("rtk grep -rn foo src")?.category).toBe("grep");
		expect(classify("rtk cat a.ts")?.category).toBe("read");
		expect(classify("rtk git status")).toBeUndefined();
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
		expect(classifyCompound("grep foo a | sort | uniq -c")).toBeUndefined();
	});

	test("a trailing | head / | tail only trims output, so it is still a stand-in", () => {
		expect(classifyCompound("grep -rn foo . | head")?.category).toBe("grep");
		expect(classifyCompound("find . -name '*.ts' | head -n 20")?.category).toBe("find");
		expect(classifyCompound("rtk grep x src | tail -5")?.category).toBe("grep");
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

describe("whole-command rules", () => {
	test("backgrounded processes map to proc", () => {
		for (const c of [
			"npm run dev &",
			"nohup vite > /tmp/v.log 2>&1 &",
			"bun run dev & sleep 3; curl localhost:3000",
			"setsid sh -c 'python app.py'",
		])
			expect(classifyCompound(c)?.category).toBe("poll");
	});

	test("&&, 2>&1, &>, quoted/escaped/commented & are not backgrounding", () => {
		for (const c of [
			"make && make install",
			"bun test 2>&1",
			"cmd &> out.log",
			'git commit -m "a & b"',
			"curl https://x.io/?a=1\\&b=2",
			"echo hi # a & b",
			"sleep 2; pgrep steam", // sleep alone is not a rule
		])
			expect(classifyCompound(c)?.category).not.toBe("poll");
	});

	test("heredoc or python script writing a real file maps to write", () => {
		for (const c of [
			"cat > src/a.ts <<'EOF'\nconst x = 1 & 2;\nEOF",
			"cat <<EOF > config.json\n{}\nEOF",
			"tee -a notes.md <<EOF\nhi\nEOF",
			"python3 - <<'PY'\np='core.py'; s=open(p).read()\nopen(p,'w').write(s)\nPY",
		])
			expect(classifyCompound(c)?.category).toBe("heredoc");
	});

	test("scratch files and piped heredocs are not file writes", () => {
		for (const c of ["cat > /tmp/p.py <<EOF\nx\nEOF", "cat <<EOF | kubectl apply -f -\nx\nEOF"])
			expect(classifyCompound(c)).toBeUndefined();
	});

	test("standalone inline python maps to python_run; piped python stays in bash", () => {
		for (const c of [
			"python3 - <<PY\nprint(open('x').read())\nPY",
			'python3 -c "print(1+1)"',
			"cd src && python <<'EOF'\nprint(2)\nEOF",
		])
			expect(classifyCompound(c)?.tool).toBe("python_run");
		for (const c of [
			"cat a.json | python3 -c 'import json,sys; print(json.load(sys.stdin))'",
			"python3 app.py",
		])
			expect(classifyCompound(c)?.tool).not.toBe("python_run");
	});
});

describe("nudgeReason", () => {
	test("active tool: point straight at it", () => {
		const msg = nudgeReason("Searching file contents via bash grep/rg.", "grep", true);
		expect(msg).toMatch(/^Searching .* Use `grep` instead\. \(Once per category;/);
	});

	test("deferred tool: load through tool_search first", () => {
		const msg = nudgeReason("Locating files via bash find/fd.", "find", false);
		expect(msg).toMatch(/Load `find` with tool_search, then call it\./);
	});

	test("names the replacing options when a hint is given", () => {
		const msg = nudgeReason(
			"Searching file contents via bash grep/rg.",
			"grep",
			true,
			"glob, limit",
		);
		expect(msg).toMatch(/Use `grep` \(glob, limit\) instead\./);
	});

	test("is a single short line", () => {
		const msg = nudgeReason(
			"Listing a directory via bash ls/tree.",
			"ls",
			false,
			"limit caps entries",
		);
		expect(msg).toMatch(/^[^\n]{1,220}$/);
	});
});

describe("nudgeFor: never names a tool the session lacks", () => {
	const rule = { reason: "Writing a file.", tool: "write", hint: "or `edit` for changes" };
	const set = (...names: string[]) => new Set(names);

	test("target, deferred loader and hint tools all registered → full nudge", () => {
		expect(nudgeFor(rule, set("write", "edit", "tool_search"), [])).toMatch(
			/^Writing a file\. Load `write` with tool_search, then call it \(or `edit` for changes\)\./,
		);
	});

	test("target missing or registry unknown → no nudge", () => {
		expect(nudgeFor(rule, set("edit", "tool_search"), ["edit"])).toBeUndefined();
		expect(nudgeFor(rule, undefined, ["write"])).toBeUndefined();
	});

	test("deferred target without tool_search → no nudge (it could not be loaded)", () => {
		expect(nudgeFor(rule, set("write", "edit"), ["edit"])).toBeUndefined();
	});

	test("active target without tool_search → direct nudge", () => {
		expect(nudgeFor(rule, set("write", "edit"), ["write"])).toMatch(/Use `write` \(or `edit`/);
	});

	test("hint names a missing tool → hint dropped, nudge kept", () => {
		expect(nudgeFor(rule, set("write"), ["write"])).toMatch(
			/^Writing a file\. Use `write` instead\./,
		);
	});
});

describe("registerToolsNudge handler", () => {
	type Notice = { msg: string; type?: string };
	test("appends the nudge to the bash result the model reads, plus a nudge card", async () => {
		const handler = makeHandler();
		const { ctx, notices } = makeCtx();

		const result = (await handler(bashEvent("cat foo.ts"), ctx)) as Result;

		expect(result?.content.map((c) => c.text)).toEqual([
			"out",
			expect.stringMatching(
				/^\[pix-nudge\] Reading .* Use `read` \(offset\/limit[^)]*\) instead\./,
			),
		]);
		expect(notices).toEqual([{ msg: expect.stringContaining("`read`"), type: "pix-nudge:tool" }]);
	});

	test("nudges once per category, untouched thereafter", async () => {
		const handler = makeHandler();
		const { ctx, notices } = makeCtx();

		await handler(bashEvent("cat a"), ctx);
		expect(await handler(bashEvent("head b"), ctx)).toBeUndefined(); // same `read` category
		expect(notices).toHaveLength(1);

		await handler(bashEvent("grep x y"), ctx); // new category → new nudge
		expect(notices).toHaveLength(2);
		expect((notices[1] as Notice).msg).toMatch(/Use `grep` \(.*\) instead/);
	});

	test("ignores commands with no tool stand-in and non-bash tools", async () => {
		const handler = makeHandler();
		const { ctx, notices } = makeCtx();

		await handler(bashEvent("git status"), ctx);
		await handler(bashEvent("cat a | grep b"), ctx); // compound — real shell work
		await handler({ ...bashEvent("cat a"), toolName: "read" }, ctx);
		await handler(bashEvent("sudo apt update"), ctx); // pix-gate's guard, not a nudge
		expect(notices).toHaveLength(0);
	});

	test("deferred tool points at tool_search", async () => {
		const handler = makeHandler([]); // nothing active → all deferred
		const { ctx } = makeCtx();

		const result = (await handler(bashEvent("ls -la"), ctx)) as Result;

		expect(result?.content[1]?.text).toMatch(/Load `ls` with tool_search/);
	});

	test("whole-command nudge names the tool and its options", async () => {
		const handler = makeHandler();
		const { ctx, notices } = makeCtx();

		await handler(bashEvent("npm run dev &"), ctx);
		await handler(bashEvent("cat > a.ts <<EOF\nx\nEOF"), ctx);

		expect(notices.map((n) => n.msg)).toEqual([
			expect.stringMatching(
				/^\[pix-nudge\] Backgrounding .* Use `proc` \(start returns a handle.*\) instead\./,
			),
			expect.stringMatching(
				/^\[pix-nudge\] Writing a file .* Use `write` \(or `edit` .*\) instead\./,
			),
		]);
	});

	test("no nudge toward a tool this session does not have", async () => {
		const handler = makeHandler(["read"], ["read"]); // no pix-proc installed
		const { ctx, notices } = makeCtx();

		expect(await handler(bashEvent("npm run dev &"), ctx)).toBeUndefined();
		expect(notices).toHaveLength(0);
	});
});
