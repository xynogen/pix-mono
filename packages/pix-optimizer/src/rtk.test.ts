import { describe, expect, it } from "bun:test";
import {
	applyRtkRewrite,
	type BashCallEvent,
	buildSudoBlockReason,
	detectSudoSegments,
	rewriteChain,
	rtkCommandFor,
	splitChain,
} from "./rtk.ts";

/** Build a fresh bash tool_call event for hook tests. */
function bashEvent(command: string): BashCallEvent {
	return { toolName: "bash", input: { command } };
}

describe("rtkCommandFor", () => {
	it("keeps a bare rtk for agent-bin and PATH hits (bash puts bin on PATH)", () => {
		expect(rtkCommandFor({ source: "bin", path: "/home/me/.pi/agent/bin/rtk" })).toBe("rtk");
		expect(rtkCommandFor({ source: "path", path: "/usr/bin/rtk" })).toBe("rtk");
	});

	it("spells out a binary.json path, quoted with forward slashes", () => {
		expect(rtkCommandFor({ source: "user", path: "C:\\tools\\rtk.exe" })).toBe(
			"'C:/tools/rtk.exe'",
		);
		expect(rtkCommandFor({ source: "user", path: "/opt/it's/rtk" })).toBe("'/opt/it'\\''s/rtk'");
	});

	it("rewriteChain uses the given prefix and treats it as already-prefixed", () => {
		expect(rewriteChain("git status && ls", "'/o/rtk'")).toBe("'/o/rtk' git status && '/o/rtk' ls");
		expect(rewriteChain("'/o/rtk' git status", "'/o/rtk'")).toBe("'/o/rtk' git status");
	});
});

describe("splitChain", () => {
	it("returns single segment for plain command", () => {
		expect(splitChain("git status")).toEqual(["git status"]);
	});

	it("splits on && keeping operator", () => {
		expect(splitChain("git add . && git push")).toEqual(["git add . ", "&&", " git push"]);
	});

	it("splits on ||, ;, |", () => {
		expect(splitChain("a || b")).toEqual(["a ", "||", " b"]);
		expect(splitChain("a ; b")).toEqual(["a ", ";", " b"]);
		expect(splitChain("a | b")).toEqual(["a ", "|", " b"]);
	});

	it("ignores operators inside double quotes", () => {
		expect(splitChain('git commit -m "a && b"')).toEqual(['git commit -m "a && b"']);
	});

	it("ignores operators inside single quotes", () => {
		expect(splitChain("echo 'x | y'")).toEqual(["echo 'x | y'"]);
	});

	it("returns null on unbalanced quotes", () => {
		expect(splitChain('git commit -m "oops')).toBeNull();
	});
});

describe("rewriteChain", () => {
	it("prefixes a single known command", () => {
		expect(rewriteChain("git status")).toBe("rtk git status");
	});

	it("prefixes every segment in a chain", () => {
		expect(rewriteChain("git add . && git commit -m x && git push")).toBe(
			"rtk git add . && rtk git commit -m x && rtk git push",
		);
	});

	it("prefixes mixed known commands", () => {
		expect(rewriteChain("cargo build && npm test")).toBe("rtk cargo build && rtk npm test");
	});

	it("leaves unknown commands alone", () => {
		expect(rewriteChain("echo hi && mkdir x")).toBe("echo hi && mkdir x");
	});

	it("does not prefix find (rtk find rejects -not/-exec)", () => {
		const cmd = "find . -type f -not -path '*/node_modules/*'";
		expect(rewriteChain(cmd)).toBe(cmd);
	});

	it("only prefixes known segments in a mixed chain", () => {
		expect(rewriteChain("cd /tmp && git status")).toBe("cd /tmp && rtk git status");
	});

	it("does not double-prefix already-rtk commands", () => {
		expect(rewriteChain("rtk git status")).toBe("rtk git status");
		expect(rewriteChain("rtk git add . && git push")).toBe("rtk git add . && rtk git push");
	});

	it("does not touch operators inside quotes", () => {
		expect(rewriteChain('git commit -m "a && b"')).toBe('rtk git commit -m "a && b"');
	});

	it("returns original on unbalanced quotes", () => {
		const cmd = 'git commit -m "oops';
		expect(rewriteChain(cmd)).toBe(cmd);
	});

	it("preserves pipe producers and only prefixes the final consumer", () => {
		expect(rewriteChain("ls -la | wc -l")).toBe("ls -la | rtk wc -l");
		expect(rewriteChain("git status --short | wc -l")).toBe("git status --short | rtk wc -l");
		expect(rewriteChain("git log | grep fix | head -5")).toBe("git log | grep fix | rtk head -5");
		expect(rewriteChain("git status | sort && git diff", "'/o/rtk'")).toBe(
			"git status | sort && '/o/rtk' git diff",
		);
	});

	it("truly leaves a chain of only-unknown commands untouched", () => {
		expect(rewriteChain("cd /tmp | sort | uniq")).toBe("cd /tmp | sort | uniq");
	});

	it("keeps quoted pipes as arguments", () => {
		expect(rewriteChain("grep 'a|b' file")).toBe("rtk grep 'a|b' file");
	});

	it.each([
		"git status --short > file.txt",
		"git status --short>>file.txt",
		"git status --short 1>file.txt",
		"git status --short >| file.txt",
		"git status --short &>file.txt",
		"git status --short &>>file.txt",
		"git status --short 2>errors.txt",
		"git status --short 2>&1",
		"git status --short >&2",
		"git status --short 1>&-",
		"git status --short | wc -l > count.txt",
		"git status --short > file.txt && git diff",
		"git status && git diff > patch.txt",
		"cat < file.txt",
		"cat <<EOF\ngit status\nEOF",
		"cat <<< 'git status'",
		"git diff <(git show HEAD:a.txt) file.txt",
		"git status > >(cat)",
		"grep 'a>b' file.txt",
		'grep "a<b" file.txt',
		"grep a\\>b file.txt",
	])("leaves commands with redirect markers unchanged: %s", (command) => {
		expect(rewriteChain(command)).toBe(command);
	});
});

// ── detectSudoSegments ───────────────────────────────────────────────────────

describe("detectSudoSegments", () => {
	it("returns empty for command with no sudo", () => {
		expect(detectSudoSegments(["git status"])).toEqual([]);
	});

	it("detects a plain sudo segment", () => {
		expect(detectSudoSegments(["sudo apt-get install foo"])).toEqual(["sudo apt-get install foo"]);
	});

	it("detects sudo in a chain (operators excluded)", () => {
		const parts = ["git status ", "&&", " sudo make install"];
		expect(detectSudoSegments(parts)).toEqual(["sudo make install"]);
	});

	it("detects multiple sudo segments", () => {
		const parts = ["sudo rm -rf /tmp ", ";", " sudo reboot"];
		expect(detectSudoSegments(parts)).toEqual(["sudo rm -rf /tmp", "sudo reboot"]);
	});

	it("does not match 'sudoer' or 'pseudo'", () => {
		expect(detectSudoSegments(["sudoers-check", "pseudo sudo"])).toEqual([]);
	});

	it("returns empty for operators-only parts", () => {
		expect(detectSudoSegments(["&&", "||", ";"])).toEqual([]);
	});
});

// ── buildSudoBlockReason ──────────────────────────────────────────────────────

describe("buildSudoBlockReason", () => {
	it("with sudo_run available: mentions sudo_run tool", () => {
		const reason = buildSudoBlockReason(["sudo apt install curl"], true);
		expect(reason).toContain("sudo_run");
		expect(reason).toContain("sudo apt install curl");
		expect(reason).not.toContain("not available");
	});

	it("with sudo_run available: instructs to strip sudo prefix", () => {
		const reason = buildSudoBlockReason(["sudo make install"], true);
		expect(reason).toContain("Strip the leading");
	});

	it("without sudo_run: explains restriction and asks user to run manually", () => {
		const reason = buildSudoBlockReason(["sudo reboot"], false);
		expect(reason).toContain("no sudo_run tool is available");
		expect(reason).toContain("manually");
		expect(reason).toContain("sudo reboot");
	});

	it("lists all blocked commands", () => {
		const reason = buildSudoBlockReason(["sudo rm -rf /tmp", "sudo reboot"], true);
		expect(reason).toContain("sudo rm -rf /tmp");
		expect(reason).toContain("sudo reboot");
	});
});

// Integration tests for the `tool_call` hook step. These guard the bug that
// silently disabled rewriting: wrong event name + wrong field + wrong patch
// mechanism. They assert on the IN-PLACE mutation contract the SDK requires.
describe("applyRtkRewrite (tool_call hook step)", () => {
	it("mutates event.input.command in place for a known bash command", () => {
		const event = bashEvent("git status");
		const changed = applyRtkRewrite(event, {
			enabled: true,
			rtkAvailable: true,
		});
		expect(changed).toBe(true);
		expect(event.input.command).toBe("rtk git status");
	});

	it("rewrites every segment of a chain in place", () => {
		const event = bashEvent("git add . && git push");
		applyRtkRewrite(event, { enabled: true, rtkAvailable: true });
		expect(event.input.command).toBe("rtk git add . && rtk git push");
	});

	it("does not mutate when disabled", () => {
		const event = bashEvent("git status");
		const changed = applyRtkRewrite(event, {
			enabled: false,
			rtkAvailable: true,
		});
		expect(changed).toBe(false);
		expect(event.input.command).toBe("git status");
	});

	it("does not mutate when rtk binary is unavailable", () => {
		const event = bashEvent("git status");
		const changed = applyRtkRewrite(event, {
			enabled: true,
			rtkAvailable: false,
		});
		expect(changed).toBe(false);
		expect(event.input.command).toBe("git status");
	});

	it("ignores non-bash tools", () => {
		const event: BashCallEvent = {
			toolName: "grep",
			input: { command: "git status" },
		};
		const changed = applyRtkRewrite(event, {
			enabled: true,
			rtkAvailable: true,
		});
		expect(changed).toBe(false);
		expect(event.input.command).toBe("git status");
	});

	it("leaves unknown commands untouched", () => {
		const event = bashEvent("mkdir build && cd build");
		const changed = applyRtkRewrite(event, {
			enabled: true,
			rtkAvailable: true,
		});
		expect(changed).toBe(false);
		expect(event.input.command).toBe("mkdir build && cd build");
	});

	it("does not double-prefix an already-rtk command", () => {
		const event = bashEvent("rtk git status");
		const changed = applyRtkRewrite(event, {
			enabled: true,
			rtkAvailable: true,
		});
		expect(changed).toBe(false);
		expect(event.input.command).toBe("rtk git status");
	});

	it("handles missing / non-string command safely", () => {
		const event: BashCallEvent = { toolName: "bash", input: {} };
		expect(applyRtkRewrite(event, { enabled: true, rtkAvailable: true })).toBe(false);
		const event2: BashCallEvent = { toolName: "bash", input: { command: 123 } };
		expect(applyRtkRewrite(event2, { enabled: true, rtkAvailable: true })).toBe(false);
	});

	it("leaves command unchanged on unbalanced quotes", () => {
		const event = bashEvent('git commit -m "oops');
		const changed = applyRtkRewrite(event, {
			enabled: true,
			rtkAvailable: true,
		});
		expect(changed).toBe(false);
		expect(event.input.command).toBe('git commit -m "oops');
	});
});
