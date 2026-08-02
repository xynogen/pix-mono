/**
 * http.ts — shared 9Router HTTP plumbing.
 *
 * auth / apiPost / curl / isCancelled were duplicated across fetch.ts,
 * search.ts and transcribe.ts. Extracted here; the only real differences were
 * timeout values (audio needs longer) and curl stdin (search pipes a body),
 * so both are parameters with the old per-file defaults.
 */

import { type ExecFileException, execFile } from "node:child_process";
import { ioTimeoutMs, ioTimeoutSignal } from "@xynogen/pix-runtime/io";
import { routerBaseUrl } from "./data.js";

export function auth(): string | undefined {
	return process.env.ROUTER_API_KEY;
}

/** POST a JSON body to a router path, returning the raw response text. */
export async function apiPost(
	path: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
	timeoutMs: number = ioTimeoutMs(),
): Promise<string> {
	const url = `${routerBaseUrl()}${path}`;
	const key = auth();
	const timeoutSignal =
		timeoutMs === ioTimeoutMs() ? ioTimeoutSignal() : AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(key ? { Authorization: `Bearer ${key}` } : {}),
		},
		body: JSON.stringify(body),
		signal: requestSignal,
	});
	if (!res.ok) {
		const errText = await res.text().catch(() => "");
		throw new Error(`API ${res.status}: ${errText.slice(0, 500)}`);
	}
	return res.text();
}

export interface CurlOptions {
	/** curl --max-time in seconds (default 25). */
	maxTime?: number;
	/** child-process kill timeout in ms (default 30_000). */
	timeoutMs?: number;
	/** Optional stdin body piped into curl. */
	stdin?: string;
}

/** Run curl with sane defaults, rejecting on non-zero exit or timeout. */
export function curl(args: string[], opts: CurlOptions = {}): Promise<string> {
	const timeoutMs = opts.timeoutMs ?? ioTimeoutMs();
	const maxTime = opts.maxTime ?? timeoutMs / 1000;
	const { stdin } = opts;
	return new Promise((resolve, reject) => {
		const child = execFile(
			"curl",
			["-sS", "--connect-timeout", "10", "--max-time", String(maxTime), ...args],
			{ maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs },
			(err, stdout, stderr) => {
				if (err) {
					const e = err as ExecFileException;
					const msg = e.killed
						? "curl timed out"
						: `curl exit ${e.code ?? "??"}: ${stderr.slice(0, 300)}`;
					reject(new Error(msg));
					return;
				}
				resolve(stdout);
			},
		);
		if (stdin && child.stdin) {
			child.stdin.write(stdin);
			child.stdin.end();
		}
	});
}

export function isCancelled(error: unknown, signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}
