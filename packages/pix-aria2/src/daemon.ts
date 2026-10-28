/**
 * aria2 RPC daemon lifecycle. We auto-spawn a private `aria2c --enable-rpc` bound
 * to loopback with a random per-session secret, then talk to it over WebSocket via
 * maria2. One daemon per pix session, torn down on shutdown.
 *
 * Why a daemon at all: aria2's speed (segmented multi-connection), resume
 * (`--continue` + control files), and robustness (auto-retry) live in the running
 * process. maria2 is only the RPC client — it ships no binary, so we manage one.
 *
 * `ponytail:` POC binds to a random ephemeral port chosen by asking the OS. If two
 * sessions race the same freed port the second spawn just retries on a new port —
 * we do not hold the port between probe and spawn. Ceiling: no port pinning/reuse
 * across sessions; upgrade to a unix socket (`--rpc-...`? aria2 lacks it) or a
 * pidfile-tracked shared daemon if multi-session sharing is ever wanted.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { BinaryMissingError, ensureTool, type ToolStatus } from "@xynogen/pix-runtime/binaries";
import { type Conn, createWebSocket, open } from "maria2/dist/index.js";

/** aria2c is missing (message carries the per-OS install hint). */
export const Aria2MissingError = BinaryMissingError;

/** Ask the OS for a free loopback TCP port. Not held — see the ponytail note above. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error("could not resolve a free port")));
			}
		});
	});
}

export interface DaemonHandle {
	conn: Conn;
	secret: string;
	port: number;
	proc: ChildProcess;
	/** Stop the RPC connection and kill the daemon. Idempotent. */
	shutdown: () => Promise<void>;
}

export interface StartDaemonOptions {
	/** Default download directory passed to aria2 (`--dir`). Defaults to cwd. */
	dir?: string;
	/** Override the aria2c binary path; otherwise resolved by pix-runtime. */
	binary?: string;
	/** Download progress when aria2c is fetched on first use (Windows). */
	onStatus?: (status: ToolStatus) => void;
	/** Milliseconds to wait for the RPC socket to come up. Default 5000. */
	readyTimeoutMs?: number;
}

/**
 * Spawn a private aria2 daemon and open an RPC connection to it.
 * Resolves aria2c via binary.json → agent bin → PATH; on Windows the official
 * release is downloaded on first use. Throws {@link Aria2MissingError} with an
 * install hint when unavailable.
 */
export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonHandle> {
	const binary =
		options.binary ?? (await ensureTool("aria2c", { onStatus: options.onStatus })).path;

	const secret = randomBytes(16).toString("hex");
	const port = await freePort();
	const proc = spawn(
		binary,
		[
			"--enable-rpc",
			"--rpc-listen-all=false",
			"--rpc-listen-port",
			String(port),
			"--rpc-secret",
			secret,
			"--dir",
			options.dir ?? process.cwd(),
			"--continue=true",
			"--auto-file-renaming=false",
			"--allow-overwrite=false",
		],
		{ stdio: "ignore" },
	);

	// If the process dies before we connect, surface it rather than hang.
	const exited = new Promise<never>((_, reject) => {
		proc.once("error", reject);
		proc.once("exit", (code) =>
			reject(new Error(`aria2c exited before RPC came up (code ${code ?? "?"})`)),
		);
	});

	const url = `ws://127.0.0.1:${port}/jsonrpc` as const;
	const timeout = options.readyTimeoutMs ?? 5000;
	let conn: Conn;
	try {
		conn = await Promise.race([connectWithRetry(url, secret, timeout), exited]);
	} catch (err) {
		// Never leave an orphan daemon holding the port when RPC did not come up.
		proc.removeAllListeners("exit");
		proc.kill("SIGTERM");
		throw err;
	}
	exited.catch(() => {}); // a later exit is handled by the caller's onExit

	let stopped = false;
	const shutdown = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		proc.removeAllListeners("exit");
		try {
			conn.socket.close();
		} catch {
			// already closing
		}
		proc.kill("SIGTERM");
	};

	return { conn, secret, port, proc, shutdown };
}

/** Poll-connect until the daemon accepts the WebSocket or the deadline passes. */
async function connectWithRetry(
	url: `ws://${string}:${number}/jsonrpc`,
	secret: string,
	timeoutMs: number,
): Promise<Conn> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			// ws:// (not wss) is deliberate: the daemon is a private process we spawned this
			// session, bound to 127.0.0.1 with a random per-session secret. Nothing leaves the
			// loopback interface, so TLS would only add cert management for zero threat surface.
			// nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
			return await open(createWebSocket(url), { secret, openTimeout: 1000 });
		} catch (err) {
			lastErr = err;
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	throw new Error(`aria2 RPC did not come up within ${timeoutMs}ms: ${String(lastErr)}`);
}
