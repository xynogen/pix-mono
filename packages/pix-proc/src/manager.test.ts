import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROC_DIR, ProcManager } from "./manager.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!pred() && Date.now() - start < timeoutMs) await wait(25);
}

// POSIX-only: uses `sleep`, `sh` job control (&) and process-group kills
// (process.kill(-pgid)). On Windows it also spawns Git's sleep.exe in popup
// consoles. ponytail: skip on win32 rather than port the suite.
describe.skipIf(process.platform === "win32")("ProcManager lifecycle", () => {
	let mgr: ProcManager;
	afterEach(async () => {
		await mgr?.shutdown();
	});

	test("start returns a running proc-* handle and unique handles", () => {
		mgr = new ProcManager();
		const a = mgr.start("sleep 5", process.cwd());
		const b = mgr.start("sleep 5", process.cwd());
		expect(a.handle).toMatch(/^proc-[a-z]+-[a-z]+-\d{2}$/);
		expect(a.status).toBe("running");
		expect(a.handle).not.toBe(b.handle);
		expect(mgr.list()).toHaveLength(2);
	});

	test("captures output and the cursor advances between reads", async () => {
		mgr = new ProcManager();
		const m = mgr.start("printf 'one\\ntwo\\n'; sleep 2", process.cwd());
		await until(() => false, 400); // let output flush
		const first = await mgr.logsSince(m.handle);
		expect(first?.lines).toEqual(["one", "two"]);
		const second = await mgr.logsSince(m.handle);
		expect(second?.lines).toEqual([]); // cursor consumed the lines
	});

	test("logsTail returns the last n and never moves the model cursor", async () => {
		mgr = new ProcManager();
		const m = mgr.start("printf 'a\\nb\\nc\\n'; sleep 2", process.cwd());
		await until(() => false, 400);
		const tail = await mgr.logsTail(m.handle, 2);
		expect(tail?.lines).toEqual(["b", "c"]);
		const since = await mgr.logsSince(m.handle);
		expect(since?.lines).toEqual(["a", "b", "c"]); // tail did not consume the cursor
	});

	test("stops recording at the byte cap while the process keeps running", async () => {
		mgr = new ProcManager(128);
		const m = mgr.start("yes hello | head -c 4096; sleep 5", process.cwd());
		await until(() => m.capped);
		expect(m.capped).toBe(true);
		expect(m.status).toBe("running");
		const path = mgr.get(m.handle)?.logPath;
		expect(path).toBeDefined();
		const size = statSync(path as string).size;
		expect(size).toBe(128);
		await wait(200);
		expect(statSync(path as string).size).toBe(128);
	});

	test("tails a large log without losing its last line", async () => {
		mgr = new ProcManager();
		const m = mgr.start(
			"printf 'é\\n'; yes x | head -c 20000; printf '\\nlast\\n'; sleep 5",
			process.cwd(),
		);
		await until(
			() =>
				m.status !== "running" ||
				(existsSync(mgr.get(m.handle)?.logPath ?? "") &&
					statSync(mgr.get(m.handle)?.logPath ?? "").size > 20000),
		);
		const tail = await mgr.logsTail(m.handle, 1);
		expect(tail?.lines).toEqual(["last"]);
	});

	test("exit is recorded with code", async () => {
		mgr = new ProcManager();
		const m = mgr.start("exit 3", process.cwd());
		await until(() => m.status !== "running");
		expect(m.status).toBe("exited");
		expect(m.exitCode).toBe(3);
	});

	test("adopts a kept orphan so this session can manage it", () => {
		mgr = new ProcManager();
		const meta = mgr.adoptOrphan({ handle: "proc-old", pgid: 1234, command: "npm run dev" });
		expect(meta).toMatchObject({
			handle: "proc-old",
			pgid: 1234,
			command: "npm run dev",
			status: "running",
		});
		expect(mgr.list()).toContainEqual(meta);
	});

	test("a kept orphan keeps its name, cwd and start time in the next session", async () => {
		const first = new ProcManager();
		const started = first.start("sleep 5", "/tmp", "frontend");
		mgr = new ProcManager();
		try {
			const orphan = (await mgr.findOrphans()).find((o) => o.handle === started.handle);
			expect(orphan).toMatchObject({ name: "frontend", cwd: "/tmp", startTime: started.startTime });
			if (!orphan) return;
			expect(mgr.adoptOrphan(orphan)).toMatchObject({ name: "frontend", cwd: "/tmp" });
		} finally {
			await first.shutdown();
		}
	});

	test("stop kills the whole process group (child + grandchild)", async () => {
		mgr = new ProcManager();
		// parent sh forks a child sleep; killing only the sh pid would orphan it.
		const m = mgr.start("sleep 30 & sleep 30", process.cwd());
		await until(() => false, 200);
		const pgid = m.pgid;
		const r = await mgr.stop(m.handle, 300);
		expect(r.ok).toBe(true);
		await until(() => m.status !== "running");
		// the whole group must be gone — signal 0 to the group throws ESRCH
		let alive = true;
		try {
			process.kill(-pgid, 0);
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);
	});

	test("rm refuses while running, removes once stopped", async () => {
		mgr = new ProcManager();
		const m = mgr.start("sleep 30", process.cwd());
		await until(() => false, 150);
		expect(mgr.rm(m.handle)).toEqual({
			ok: false,
			note: `${m.handle} still running — stop it first`,
		});
		await mgr.stop(m.handle, 300);
		await until(() => m.status !== "running");
		const logPath = mgr.get(m.handle)?.logPath;
		const r = mgr.rm(m.handle);
		expect(r.ok).toBe(true);
		expect(mgr.list()).toHaveLength(0);
		if (logPath) expect(existsSync(logPath)).toBe(false);
	});

	test("stop on an already-exited process is a no-op success", async () => {
		mgr = new ProcManager();
		const m = mgr.start("exit 0", process.cwd());
		await until(() => m.status !== "running");
		const r = await mgr.stop(m.handle, 100);
		expect(r.ok).toBe(true);
		expect(r.note).toContain("exited(0)");
	});

	test("unknown handle fails cleanly", async () => {
		mgr = new ProcManager();
		expect(await mgr.logsSince("proc-nope-nope-00")).toBeUndefined();
		expect((await mgr.stop("proc-nope-nope-00")).ok).toBe(false);
		expect(mgr.rm("proc-nope-nope-00").ok).toBe(false);
	});

	test("a missing cwd throws a clear error and does not crash the host", async () => {
		mgr = new ProcManager();
		expect(() => mgr.start("echo hi", "/definitely/not/here")).toThrow(
			"cwd does not exist: /definitely/not/here",
		);
		await wait(100); // the async 'error' event fires here; an unhandled one fails the test
		expect(mgr.list()).toHaveLength(0);
	});

	test("pidfiles with unsafe group ids are discarded, never signalled", async () => {
		mgr = new ProcManager();
		const bad = [-1, 0, 1, "x", 1.5].map((pgid, i) => {
			const handle = `proc-bad-pgid-${i}`;
			writeFileSync(join(PROC_DIR, `${handle}.pid`), JSON.stringify({ pgid, command: "x" }));
			return handle;
		});
		const orphans = await mgr.findOrphans();
		expect(orphans.filter((o) => bad.includes(o.handle))).toEqual([]);
		for (const h of bad) expect(existsSync(join(PROC_DIR, `${h}.pid`))).toBe(false);
	});
});
