/**
 * http.ts — shared 9Router HTTP plumbing.
 *
 * auth / apiPost / curl / isCancelled were duplicated across fetch.ts,
 * search.ts and transcribe.ts. Extracted here; the only real differences were
 * timeout values (audio needs longer) and curl stdin (search pipes a body),
 * so both are parameters with the old per-file defaults.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
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
	/** Request timeout in ms (default ioTimeoutMs()). */
	timeoutMs?: number;
	/** Optional request body (was piped to curl stdin). */
	stdin?: string;
}

// ponytail: this is NOT a general curl shim — it parses only the flag forms the
// three fallback call sites actually pass (-L, -X, -H, -d, -F key=value /
// file=@path, plus the -sS/--connect-timeout/--max-time defaults added below).
// New curl flags won't work here; extend the parser or call fetch directly.
function curlArgsToRequest(args: string[]): { url: string; init: RequestInit } {
	const headers = new Headers();
	let method = "GET";
	let body: string | undefined;
	let form: FormData | undefined;
	let url = "";
	for (let i = 0; i < args.length; i++) {
		const a = args[i] ?? "";
		switch (a) {
			case "-sS":
			case "-L":
				break; // silent / follow-redirects are fetch defaults
			case "--connect-timeout":
			case "--max-time":
				i++; // value handled by AbortSignal below
				break;
			case "-X":
				method = args[++i] ?? method;
				break;
			case "-H": {
				const h = args[++i] ?? "";
				const idx = h.indexOf(":");
				if (idx >= 0) headers.set(h.slice(0, idx).trim(), h.slice(idx + 1).trim());
				break;
			}
			case "-d":
				body = args[++i] ?? "";
				break;
			case "-F": {
				form ??= new FormData();
				const field = args[++i] ?? "";
				const eq = field.indexOf("=");
				const key = field.slice(0, eq);
				const val = field.slice(eq + 1);
				if (val.startsWith("@")) {
					const path = val.slice(1);
					form.set(key, new Blob([readFileSync(path)]), basename(path));
				} else {
					form.set(key, val);
				}
				break;
			}
			default:
				if (!a.startsWith("-")) url = a; // positional = URL
		}
	}
	const init: RequestInit = { method };
	if (form)
		init.body = form; // let fetch set the multipart boundary
	else if (body !== undefined) init.body = body;
	if ([...headers.keys()].length > 0) init.headers = headers;
	return { url, init };
}

/** Raw fetch fallback (curl-signature compatible), rejecting on non-2xx or timeout. */
export async function curl(args: string[], opts: CurlOptions = {}): Promise<string> {
	const timeoutMs = opts.timeoutMs ?? ioTimeoutMs();
	const { url, init } = curlArgsToRequest(args);
	if (opts.stdin !== undefined) init.body = opts.stdin;
	init.signal = AbortSignal.timeout(timeoutMs);
	let res: Response;
	try {
		res = await fetch(url, init);
	} catch (err) {
		if (err instanceof DOMException && err.name === "TimeoutError") {
			throw new Error("curl timed out");
		}
		throw new Error(`curl failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!res.ok) {
		const errText = await res.text().catch(() => "");
		throw new Error(`curl exit ${res.status}: ${errText.slice(0, 300)}`);
	}
	return res.text();
}

export function isCancelled(error: unknown, signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}
