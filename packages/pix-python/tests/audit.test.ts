import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { setUnattendedMode } from "@xynogen/pix-runtime";
import { type PathAccess, requestPathAccess } from "@xynogen/pix-runtime/path-access";
import { tempDir } from "@xynogen/pix-runtime/paths";
import registerGate from "../../pix-gate/src/index.ts";
import { runPython } from "../src/lib.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(opts: { approved?: boolean; hasUI?: boolean; mode?: "afk" | "nuclear" } = {}) {
	const root = mkdtempSync(join(tempDir(), "pix-python-audit-"));
	roots.push(root);
	writeFileSync(join(root, ".env"), "secret-value");
	const events = createEventBus();
	registerGate({ events, on() {} } as unknown as ExtensionAPI);
	if (opts.mode) setUnattendedMode(events, opts.mode);
	const states: string[] = [];
	events.on("pix:agent-state", (raw) => states.push((raw as { state: string }).state));
	let dialogs = 0;
	let notifications = 0;
	const context = {
		cwd: root,
		hasUI: opts.hasUI ?? true,
		ui: {
			custom: async () => {
				dialogs++;
				return { action: opts.approved ? "approved" : "denied" };
			},
			notify() {
				notifications++;
			},
		},
	} as unknown as ExtensionContext;
	const accesses: PathAccess[] = [];
	const run = (code: string) =>
		runPython(code, root, undefined, "python3", 10_000, (access) => {
			accesses.push(access);
			return requestPathAccess(events, { ...access, context });
		});
	return {
		root,
		run,
		accesses,
		states,
		dialogs: () => dialogs,
		notifications: () => notifications,
	};
}

describe("runtime Python path gate", () => {
	test("symlink plus parent traversal checks the actual resolved path", async () => {
		const f = fixture();
		mkdirSync(join(f.root, "private", "child"), { recursive: true });
		writeFileSync(join(f.root, "private", ".env"), "other-secret");
		symlinkSync(join(f.root, "private", "child"), join(f.root, "link"), "dir");
		const r = await f.run('print(open("link/../.env").read())');
		expect(r.code).not.toBe(0);
		expect(r.stdout).toBe("");
		expect(f.accesses.some((a) => a.paths.includes(join(f.root, "private", ".env")))).toBe(true);
	});

	test("directory listings and bytes paths use the same rules", async () => {
		const f = fixture();
		mkdirSync(join(f.root, ".ssh"));
		expect((await f.run('import os\nos.listdir(".ssh")')).code).not.toBe(0);
		expect(
			(await f.run('import os\nfd = os.open(b".env", os.O_RDONLY)\nprint(os.read(fd, 100))')).code,
		).not.toBe(0);
		expect(f.dialogs()).toBe(2);
	});

	test.skipIf(process.platform !== "linux")(
		"dir_fd paths resolve against the descriptor, not cwd",
		async () => {
			const f = fixture();
			mkdirSync(join(f.root, "private"));
			writeFileSync(join(f.root, "private", ".env"), "other-secret");
			const r = await f.run(
				'import os\nd = os.open("private", os.O_RDONLY)\nos.remove(".env", dir_fd=d)',
			);
			expect(r.code).not.toBe(0);
			expect(readFileSync(join(f.root, "private", ".env"), "utf8")).toBe("other-secret");
		},
	);

	test("timeout ends a waiting process and aborts its pending decision", async () => {
		const f = fixture();
		let decisionSignal: AbortSignal | undefined;
		const r = await runPython(
			'open(".env").read()',
			f.root,
			undefined,
			"python3",
			500,
			async (access) => {
				decisionSignal = access.signal;
				return new Promise((resolve) =>
					access.signal?.addEventListener(
						"abort",
						() => resolve({ approved: false, reason: "Stopped" }),
						{ once: true },
					),
				);
			},
		);
		expect(r.timedOut).toBe(true);
		expect(decisionSignal?.aborted).toBe(true);
	});

	test("ordinary Python and shell-looking strings need no approval; local imports still work", async () => {
		const f = fixture({ hasUI: false });
		writeFileSync(join(f.root, "helper.py"), "answer = 42\n");
		const r = await f.run('import helper\nprint(helper.answer)\nprint("sudo rm -rf /")');
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("42\nsudo rm -rf /\n");
		expect(f.dialogs()).toBe(0);
		expect(f.states).toEqual([]);
	});

	test("computed pathlib reads pause before access and deny without exposing contents", async () => {
		const f = fixture();
		const r = await f.run(
			'from pathlib import Path\np = Path.cwd() / ("." + "env")\nprint(p.read_text())',
		);
		expect(r.code).not.toBe(0);
		expect(r.stdout).not.toContain("secret-value");
		expect(r.stderr).toContain("PermissionError");
		expect(f.accesses.some((a) => a.op === "read" && a.paths.includes(join(f.root, ".env")))).toBe(
			true,
		);
		expect(f.dialogs()).toBe(1);
		expect(f.states).toEqual(["blocked", "idle"]);
	});

	test("denied write cannot truncate an existing sensitive file", async () => {
		const f = fixture();
		const r = await f.run('open(".env", "w").write("changed")');
		expect(r.code).not.toBe(0);
		expect(readFileSync(join(f.root, ".env"), "utf8")).toBe("secret-value");
		expect(f.accesses.some((a) => a.op === "write" && a.paths.includes(join(f.root, ".env")))).toBe(
			true,
		);
	});

	test("approval resumes the exact pending access", async () => {
		const f = fixture({ approved: true });
		const r = await f.run('print(open(".env").read())');
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("secret-value\n");
		expect(f.dialogs()).toBe(1);
	});

	test.each([
		{ hasUI: false },
		{ mode: "afk" as const },
	])("headless and AFK deny sensitive access", async (opts) => {
		const f = fixture(opts);
		const r = await f.run('print(open(".env").read())');
		expect(r.code).not.toBe(0);
		expect(r.stdout).toBe("");
		expect(f.dialogs()).toBe(0);
	});

	test("nuclear retains the existing path-policy bypass", async () => {
		const f = fixture({ mode: "nuclear", hasUI: false });
		expect((await f.run('print(open(".env").read())')).stdout).toBe("secret-value\n");
		expect(f.dialogs()).toBe(0);
	});

	test("symlink targets are checked, not only the harmless alias", async () => {
		const f = fixture();
		symlinkSync(join(f.root, ".env"), join(f.root, "alias"));
		const r = await f.run('print(open("alias").read())');
		expect(r.code).not.toBe(0);
		expect(r.stdout).toBe("");
		expect(f.dialogs()).toBe(1);
	});

	test.each([
		'import os\nos.remove(".env")',
		'import os\nos.rename(".env", "moved")',
		'import os\nos.truncate(".env", 0)',
	])("filesystem mutations are checked before changing sensitive files", async (code) => {
		const f = fixture();
		expect((await f.run(code)).code).not.toBe(0);
		expect(readFileSync(join(f.root, ".env"), "utf8")).toBe("secret-value");
	});

	test("write-only info rules do not gate reads", async () => {
		const f = fixture();
		const r = await f.run(
			'import os\nos.mkdir("node_modules")\np = "node_modules/test.txt"\nopen(p, "w").write("ok")\nprint(open(p).read())',
		);
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("ok\n");
		expect(f.notifications()).toBe(2);
		expect(f.dialogs()).toBe(0);
	});

	test("gate failures fail closed", async () => {
		const f = fixture();
		const r = await runPython(
			'print(open(".env").read())',
			f.root,
			undefined,
			"python3",
			10_000,
			async () => {
				throw new Error("broken policy");
			},
		);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("Path gate failed");
		expect(r.stdout).toBe("");
	});

	test("cancellation stops Python while a decision is pending and releases the decision signal", async () => {
		const f = fixture();
		const controller = new AbortController();
		let started!: () => void;
		const waiting = new Promise<void>((resolve) => {
			started = resolve;
		});
		let decisionSignal: AbortSignal | undefined;
		const result = runPython(
			'open(".env").read()',
			f.root,
			controller.signal,
			"python3",
			undefined,
			async (access) => {
				decisionSignal = access.signal;
				started();
				return new Promise((resolve) =>
					access.signal?.addEventListener(
						"abort",
						() => resolve({ approved: false, reason: "Cancelled" }),
						{ once: true },
					),
				);
			},
		);
		await waiting;
		controller.abort(new Error("stop"));
		await expect(result).rejects.toThrow("stop");
		expect(decisionSignal?.aborted).toBe(true);
	});
});
