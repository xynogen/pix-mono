import { describe, expect, it } from "bun:test";
import {
	baseSshArgs,
	commandEscalatesPrivilege,
	controlPathFor,
	detectSshFailure,
	detectSudoFailure,
	filterSudoPrompt,
	hostApproved,
	hostTarget,
	isUnreachable,
	parseHost,
	remoteCommand,
	shellQuote,
	truncate,
} from "./lib.ts";

describe("parseHost", () => {
	it("parses bare host", () => {
		expect(parseHost("example.com")).toEqual({ host: "example.com" });
	});
	it("parses user@host", () => {
		expect(parseHost("deploy@10.0.0.5")).toEqual({ user: "deploy", host: "10.0.0.5" });
	});
	it("parses user@host:port", () => {
		expect(parseHost("deploy@10.0.0.5:2222")).toEqual({
			user: "deploy",
			host: "10.0.0.5",
			port: 2222,
		});
	});
	it("parses bracketed IPv6 with port", () => {
		expect(parseHost("root@[::1]:22")).toEqual({ user: "root", host: "::1", port: 22 });
	});
	it("leaves bare IPv6 (multiple colons) as host", () => {
		expect(parseHost("fe80::1")).toEqual({ host: "fe80::1" });
	});
	it("rejects empty host", () => {
		expect(() => parseHost("   ")).toThrow();
		expect(() => parseHost("user@")).toThrow();
	});
	it("rejects invalid port", () => {
		expect(() => parseHost("h:0")).toThrow();
		expect(() => parseHost("h:70000")).toThrow();
		expect(() => parseHost("h:abc")).toThrow();
	});
});

describe("hostTarget", () => {
	it("joins user and host", () => {
		expect(hostTarget({ user: "a", host: "b" })).toBe("a@b");
		expect(hostTarget({ host: "b" })).toBe("b");
	});
});

describe("controlPathFor", () => {
	it("is stable per host+user+port and differs across hosts", () => {
		const a = controlPathFor({ user: "u", host: "h", port: 22 });
		expect(a).toBe(controlPathFor({ user: "u", host: "h", port: 22 }));
		expect(a).not.toBe(controlPathFor({ user: "u", host: "h", port: 23 }));
		expect(a).not.toBe(controlPathFor({ user: "x", host: "h", port: 22 }));
		expect(a).toContain("pix-ssh-");
		expect(a.endsWith(".sock")).toBe(true);
	});
});

describe("baseSshArgs", () => {
	it("enables multiplexing and includes the control path", () => {
		const args = baseSshArgs({ host: "h" }, "/tmp/x.sock");
		expect(args).toContain("ControlMaster=auto");
		expect(args).toContain("ControlPath=/tmp/x.sock");
		expect(args.some((a) => a.startsWith("ControlPersist="))).toBe(true);
	});
	it("adds -p only when a port is set", () => {
		expect(baseSshArgs({ host: "h" }, "s")).not.toContain("-p");
		const withPort = baseSshArgs({ host: "h", port: 2222 }, "s");
		expect(withPort).toContain("-p");
		expect(withPort).toContain("2222");
	});
});

describe("remoteCommand + shellQuote", () => {
	it("returns the command unchanged without sudo", () => {
		expect(remoteCommand("whoami", false)).toBe("whoami");
	});
	it("wraps in sudo -S with a quoted inner command", () => {
		const out = remoteCommand("apt update", true);
		expect(out).toStartWith("sudo -S -p '' -- sh -c ");
		expect(out).toContain("'apt update'");
	});
	it("escapes embedded single quotes safely", () => {
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
		// The wrapped form has no unescaped quote that would break out of the string.
		const wrapped = remoteCommand("echo 'hi'", true);
		expect(wrapped).toContain(`'echo '\\''hi'\\'''`);
	});
});

describe("detectSshFailure", () => {
	it("is false on exit 0", () => {
		expect(detectSshFailure(0, "permission denied")).toBe(false);
	});
	it("flags common ssh errors", () => {
		expect(detectSshFailure(255, "Permission denied (publickey,password).")).toBe(true);
		expect(detectSshFailure(255, "ssh: connect to host x: Connection refused")).toBe(true);
		expect(detectSshFailure(255, "Could not resolve hostname x")).toBe(true);
	});
	it("does not flag a normal nonzero command exit", () => {
		expect(detectSshFailure(1, "ls: no such file")).toBe(false);
	});
});

describe("isUnreachable", () => {
	it("flags connection/DNS failures (not auth)", () => {
		expect(isUnreachable("ssh: connect to host x port 22: Connection timed out")).toBe(true);
		expect(isUnreachable("ssh: connect to host x port 22: Connection refused")).toBe(true);
		expect(isUnreachable("ssh: Could not resolve hostname x")).toBe(true);
		expect(isUnreachable("ssh: connect to host x: No route to host")).toBe(true);
	});
	it("does NOT flag a password rejection (that's an auth failure)", () => {
		expect(isUnreachable("Permission denied, please try again.")).toBe(false);
		expect(isUnreachable("Permission denied (publickey,password).")).toBe(false);
	});
});

describe("detectSudoFailure", () => {
	it("flags wrong sudo password", () => {
		expect(detectSudoFailure("Sorry, try again.")).toBe(true);
		expect(detectSudoFailure("sudo: 1 incorrect password attempt")).toBe(true);
		expect(detectSudoFailure("sudo: a password is required")).toBe(true);
	});
	it("ignores unrelated stderr", () => {
		expect(detectSudoFailure("warning: something")).toBe(false);
	});
});

describe("filterSudoPrompt", () => {
	it("strips bare password prompt lines", () => {
		expect(filterSudoPrompt("[sudo] password for u:\nreal output")).toBe("real output");
		expect(filterSudoPrompt("Password:\nx")).toBe("x");
	});
	it("keeps normal lines", () => {
		expect(filterSudoPrompt("line one\nline two")).toBe("line one\nline two");
	});
});

describe("hostApproved", () => {
	it("is false for an unknown host", () => {
		expect(hostApproved(new Map(), "u@h:22")).toBe(false);
	});
	it("is true within the TTL window", () => {
		const m = new Map([["u@h:22", 1000]]);
		expect(hostApproved(m, "u@h:22", 500)).toBe(true);
	});
	it("expires and self-prunes at/after the deadline", () => {
		const m = new Map([["u@h:22", 1000]]);
		expect(hostApproved(m, "u@h:22", 1000)).toBe(false);
		expect(m.has("u@h:22")).toBe(false);
	});
});

describe("commandEscalatesPrivilege", () => {
	it("flags leading and mid-chain escalation tokens", () => {
		expect(commandEscalatesPrivilege("sudo apt update")).toBe(true);
		expect(commandEscalatesPrivilege("apt update && sudo apt install x")).toBe(true);
		expect(commandEscalatesPrivilege("foo; su -c 'x'")).toBe(true);
		expect(commandEscalatesPrivilege("doas reboot")).toBe(true);
		expect(commandEscalatesPrivilege("pkexec whoami")).toBe(true);
	});
	it("does not flag plain commands or substrings", () => {
		expect(commandEscalatesPrivilege("ls -la")).toBe(false);
		expect(commandEscalatesPrivilege("pseudo-tty")).toBe(false);
		expect(commandEscalatesPrivilege("cat sudoku.txt")).toBe(false);
	});
});

describe("truncate", () => {
	it("passes short text through", () => {
		expect(truncate("a\nb").truncated).toBe(false);
	});
	it("caps by line count", () => {
		const many = Array.from({ length: 3000 }, (_, i) => `l${i}`).join("\n");
		const out = truncate(many, 2000);
		expect(out.truncated).toBe(true);
		expect(out.text.split("\n").length).toBe(2000);
	});
});
