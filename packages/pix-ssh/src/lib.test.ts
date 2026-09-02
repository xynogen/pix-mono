import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSsh from "./index.ts";
import {
	baseScpArgs,
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
	parseSshConfig,
	remoteCommand,
	remoteTransferPath,
	shellQuote,
	transferApprovalDecision,
	transferArgs,
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

describe("parseSshConfig", () => {
	it("reads effective user, hostname, and port from ssh -G output", () => {
		expect(parseSshConfig("host orin\nuser jetson\nhostname 10.10.21.251\nport 2222\n")).toEqual({
			user: "jetson",
			host: "10.10.21.251",
			port: 2222,
		});
	});

	it("rejects incomplete ssh -G output", () => {
		expect(parseSshConfig("hostname 10.10.21.251\n")).toBeUndefined();
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

describe("transfer unattended approval", () => {
	it("treats transfer as warning-level in AFK and YOLO", () => {
		expect(transferApprovalDecision("off", false)).toBe("ask");
		expect(transferApprovalDecision("afk", false)).toBe("allow");
		expect(transferApprovalDecision("yolo", false)).toBe("allow");
	});

	it("denies unattended transfer when a login password is missing", () => {
		expect(transferApprovalDecision("afk", true)).toBe("deny");
		expect(transferApprovalDecision("yolo", true)).toBe("deny");
	});
});

describe("SCP transfer arguments", () => {
	it("builds upload and download endpoints", () => {
		const spec = { user: "deploy", host: "example.com", port: 2222 };
		expect(remoteTransferPath(spec, "/srv/app file")).toBe("deploy@example.com:/srv/app file");
		expect(transferArgs(spec, "upload", "./build", "/srv/app")).toEqual([
			"./build",
			"deploy@example.com:/srv/app",
		]);
		expect(transferArgs(spec, "download", "/var/log/app.log", "./app.log")).toEqual([
			"deploy@example.com:/var/log/app.log",
			"./app.log",
		]);
		expect(baseScpArgs(spec, "/tmp/control.sock", true)).toEqual([
			"-o",
			"ControlMaster=auto",
			"-o",
			"ControlPath=/tmp/control.sock",
			"-o",
			"ControlPersist=120",
			"-o",
			"ConnectTimeout=10",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-P",
			"2222",
			"-r",
		]);
	});

	it("brackets IPv6 hosts for SCP remote-path syntax", () => {
		expect(remoteTransferPath({ user: "root", host: "::1" }, "/tmp/x")).toBe("root@[::1]:/tmp/x");
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

describe("ssh result renderer", () => {
	const theme = {
		fg: (key: string, text: string) => `[${key}]${text}[/]`,
		bold: (text: string) => text,
	};
	const register = () => {
		let renderer: ((...args: unknown[]) => { render(width: number): string[] }) | undefined;
		registerSsh({
			registerTool(tool: unknown) {
				renderer = (tool as { renderResult: typeof renderer }).renderResult;
			},
		} as unknown as ExtensionAPI);
		if (!renderer) throw new Error("renderResult not registered");
		return renderer;
	};
	const render = (
		renderer: (...args: unknown[]) => { render(width: number): string[] },
		details: Record<string, unknown> | undefined,
		isError = false,
		isPartial = false,
		state: Record<string, unknown> = {},
		expanded = true,
	) =>
		renderer(
			{ content: [{ type: "text", text: String(details?.outcome ?? "done") }], details },
			{ isPartial },
			theme,
			{ expanded, isError, invalidate: () => {}, state },
		)
			.render(24)
			.join("\n");

	it("frames open terminal outcomes and generic results by status", () => {
		const renderer = register();
		expect(render(renderer, undefined)).toContain("[success]─");
		expect(render(renderer, undefined, true)).toContain("[error]─");
		for (const outcome of ["denied", "timed-out", "cancelled", "error"]) {
			expect(
				render(renderer, {
					_type: "sshResult",
					command: "id",
					host: "host",
					sudo: false,
					outcome,
				}),
			).toContain("[error]─");
		}
	});

	it("leaves partial, running, and collapsed rows unframed", () => {
		const renderer = register();
		const running = {
			_type: "sshResult",
			command: "id",
			host: "host",
			sudo: false,
			outcome: "running",
		};
		expect(render(renderer, running, false, true)).not.toContain("[success]─");
		expect(render(renderer, running)).not.toContain("[success]─");
		const success = { ...running, outcome: "success", exitCode: 0, _render: "done" };
		expect(render(renderer, success, false, false, { collapsed: true }, false)).not.toContain("─");
	});
});
