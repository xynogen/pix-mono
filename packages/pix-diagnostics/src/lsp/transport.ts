/**
 * transport.ts — one cancellable JSON-RPC connection to one language server.
 *
 * Responsibilities:
 *  - spawn the server, run the LSP `initialize`/`initialized` handshake,
 *  - keep monotonic document versions per URI with 32-document LRU eviction,
 *  - cache the latest `publishDiagnostics` per URI (version + arrival sequence),
 *  - resolve `waitForDiagnostics` on a matching event, with a settle window for
 *    push-only servers that publish in phases,
 *  - forward abort signals to pending waits and requests,
 *  - reject all waits when the child exits, and clean up on `stop()`.
 *
 * It advertises UTF-16 only and fails when a server picks another encoding.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	CancellationTokenSource,
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";

export interface StartOptions {
	command: string;
	args: readonly string[];
	cwd: string;
	rootUri: string;
	serverId: string;
	env?: NodeJS.ProcessEnv;
	/** Deadline for the initialize handshake. Default {@link INIT_TIMEOUT_MS}. */
	initTimeoutMs?: number;
	/** Local deadline per request. Default {@link REQUEST_TIMEOUT_MS}. */
	requestTimeoutMs?: number;
}

export interface LspDiagnostic {
	severity: number;
	message: string;
	line: number;
	character: number;
	endLine: number;
	endCharacter: number;
	source?: string;
	code?: string | number;
}

interface LspRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

interface RawDiagnostic {
	range: LspRange;
	severity?: number;
	message: string;
	source?: string;
	code?: string | number;
}

interface PublishEvent {
	version?: number;
	diagnostics: LspDiagnostic[];
	seq: number;
}

type TransportState = "starting" | "ready" | "failed" | "stopped";

const MAX_OPEN = 32;
const STDERR_CAP = 8 * 1024;
// A server that never answers must not hang a tool call. $/cancelRequest is
// only advisory, so both deadlines are enforced locally.
export const INIT_TIMEOUT_MS = 15_000;
export const REQUEST_TIMEOUT_MS = 30_000;

/** Reject `p` after `ms`; `onTimeout` runs first so callers can tear down. */
function withDeadline<T>(
	p: Promise<T>,
	ms: number,
	label: string,
	onTimeout?: () => void,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			onTimeout?.();
			reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
		}, ms);
		timer.unref?.();
	});
	return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

class AbortError extends Error {
	override name = "AbortError";
}

function mapDiagnostic(d: RawDiagnostic): LspDiagnostic {
	return {
		severity: d.severity ?? 1,
		message: d.message,
		line: d.range.start.line,
		character: d.range.start.character,
		endLine: d.range.end.line,
		endCharacter: d.range.end.character,
		source: d.source,
		code: d.code,
	};
}

function diagnosticUri(uri: string): string {
	if (!uri.startsWith("file:")) return uri;
	const canonical = pathToFileURL(fileURLToPath(uri)).href;
	// Windows drive letters vary by server. Keep the remaining path case unchanged.
	return canonical.replace(
		/^file:\/\/\/([A-Z]):/i,
		(_all, drive: string) => `file:///${drive.toUpperCase()}:`,
	);
}

interface LspPosition {
	line: number;
	character: number;
}

/** LSP position (UTF-16 units; `\r\n`, `\n` and `\r` end a line) of `offset` in `text`. */
function positionAt(text: string, offset: number): LspPosition {
	let line = 0;
	let lineStart = 0;
	for (let i = 0; i < offset; i++) {
		const ch = text[i];
		if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, character: offset - lineStart };
}

/** True when `i` falls inside a `\r\n` pair or a surrogate pair. */
function splitsPair(text: string, i: number): boolean {
	if (text[i - 1] === "\r" && text[i] === "\n") return true;
	const hi = text.charCodeAt(i - 1);
	const lo = text.charCodeAt(i);
	return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

/**
 * One ranged LSP change that turns `prev` into `next` (common prefix and suffix
 * kept), or undefined when the texts are equal. Edits stay small, so the server
 * re-parses only the changed span.
 */
export function rangedChange(
	prev: string,
	next: string,
): { range: { start: LspPosition; end: LspPosition }; text: string } | undefined {
	if (prev === next) return undefined;
	const max = Math.min(prev.length, next.length);
	let start = 0;
	while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
	let tail = 0;
	while (
		tail < max - start &&
		prev.charCodeAt(prev.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)
	)
		tail++;
	while (start > 0 && splitsPair(prev, start)) start--;
	while (tail > 0 && splitsPair(prev, prev.length - tail)) tail--;
	return {
		range: { start: positionAt(prev, start), end: positionAt(prev, prev.length - tail) },
		text: next.slice(start, next.length - tail),
	};
}

export class LspTransport {
	private stateValue: TransportState = "starting";
	private seq = 0;
	private readonly diagnostics = new Map<string, PublishEvent>();
	private readonly waiters = new Set<() => void>();
	private readonly versions = new Map<string, number>();
	/** Last text sent per URI, the base for ranged changes. */
	private readonly texts = new Map<string, string>();
	/** Publish `seq` at the last didOpen/didChange per URI; unversioned publishes must be newer. */
	private readonly sentSeq = new Map<string, number>();
	private incrementalSync = false;
	/** Insertion-ordered open URIs for LRU eviction. */
	private readonly openOrder: string[] = [];
	private readonly openLanguage = new Map<string, string>();
	private pullCapable = false;
	private stderr = "";
	private exitReason: string | undefined;
	private ewmaMs = 0;
	private requestTimeoutMs = REQUEST_TIMEOUT_MS;

	private constructor(
		private readonly child: ChildProcess,
		private readonly connection: MessageConnection,
		private readonly serverId: string,
	) {}

	static async start(options: StartOptions): Promise<LspTransport> {
		const child = spawn(options.command, [...options.args], {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: options.env ?? process.env,
		});
		// A spawn failure (ENOENT, EACCES) arrives as an async 'error' event. Without
		// a listener Node rethrows it and takes Pi down; with one, it fails start().
		const spawnFailed = new Promise<never>((_, reject) => {
			child.once("error", (err) =>
				reject(new Error(`LSP ${options.serverId}: failed to start: ${err.message}`)),
			);
		});
		spawnFailed.catch(() => {}); // late errors after a successful start are not fatal
		if (!child.stdin || !child.stdout || !child.stderr) {
			child.kill();
			throw new Error(`LSP ${options.serverId}: failed to open stdio pipes`);
		}
		const connection = createMessageConnection(
			new StreamMessageReader(child.stdout),
			new StreamMessageWriter(child.stdin),
		);
		const transport = new LspTransport(child, connection, options.serverId);
		transport.wire(options);
		transport.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
		connection.listen();

		try {
			await withDeadline(
				Promise.race([transport.initialize(options.rootUri), spawnFailed]),
				options.initTimeoutMs ?? INIT_TIMEOUT_MS,
				`LSP ${options.serverId}: initialize`,
			);
			transport.stateValue = "ready";
			return transport;
		} catch (error) {
			transport.stateValue = "failed";
			transport.cleanup();
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	private wire(_options: StartOptions): void {
		this.child.stderr?.on("data", (chunk: Buffer) => {
			if (this.stderr.length < STDERR_CAP) {
				this.stderr = (this.stderr + chunk.toString()).slice(0, STDERR_CAP);
			}
		});
		this.child.on("exit", (code, signal) => {
			this.exitReason = `exited (code=${code ?? "null"} signal=${signal ?? "null"})`;
			if (this.stateValue !== "stopped") this.stateValue = "failed";
			this.wakeWaiters();
		});
		this.connection.onNotification(
			"textDocument/publishDiagnostics",
			(params: { uri: string; version?: number; diagnostics: RawDiagnostic[] }) => {
				this.diagnostics.set(diagnosticUri(params.uri), {
					version: params.version,
					diagnostics: params.diagnostics.map(mapDiagnostic),
					seq: ++this.seq,
				});
				this.wakeWaiters();
			},
		);
		this.connection.onError(() => {
			this.wakeWaiters();
		});
		this.connection.onClose(() => {
			if (this.stateValue !== "stopped") this.stateValue = "failed";
			this.wakeWaiters();
		});
	}

	private async initialize(rootUri: string): Promise<void> {
		const result = (await this.connection.sendRequest("initialize", {
			processId: process.pid,
			rootUri,
			workspaceFolders: [{ uri: rootUri, name: "root" }],
			capabilities: {
				general: { positionEncodings: ["utf-16"] },
				textDocument: {
					synchronization: { didSave: true },
					publishDiagnostics: { versionSupport: true },
					diagnostic: {},
				},
			},
		})) as {
			capabilities?: {
				positionEncoding?: string;
				diagnosticProvider?: unknown;
				textDocumentSync?: number | { change?: number };
			};
		};

		const encoding = result.capabilities?.positionEncoding;
		if (encoding && encoding !== "utf-16") {
			throw new Error(`LSP ${this.serverId}: server selected unsupported encoding ${encoding}`);
		}
		this.pullCapable = Boolean(result.capabilities?.diagnosticProvider);
		const sync = result.capabilities?.textDocumentSync;
		// TextDocumentSyncKind.Incremental = 2.
		this.incrementalSync = (typeof sync === "number" ? sync : sync?.change) === 2;
		this.connection.sendNotification("initialized", {});
	}

	private wakeWaiters(): void {
		for (const wake of [...this.waiters]) wake();
	}

	private uriFor(filePath: string): string {
		return diagnosticUri(pathToFileURL(filePath).href);
	}

	private touchOpen(uri: string): void {
		const idx = this.openOrder.indexOf(uri);
		if (idx !== -1) this.openOrder.splice(idx, 1);
		this.openOrder.push(uri);
	}

	private async evictIfNeeded(): Promise<void> {
		while (this.openOrder.length > MAX_OPEN) {
			const victim = this.openOrder.shift();
			if (!victim) break;
			this.forget(victim);
			this.connection.sendNotification("textDocument/didClose", {
				textDocument: { uri: victim },
			});
		}
	}

	async open(filePath: string, languageId: string, text: string, version: number): Promise<void> {
		const uri = this.uriFor(filePath);
		if (this.openLanguage.has(uri)) {
			await this.change(filePath, text, version);
			return;
		}
		this.versions.set(uri, version);
		this.openLanguage.set(uri, languageId);
		this.texts.set(uri, text);
		this.sentSeq.set(uri, this.seq);
		this.touchOpen(uri);
		this.connection.sendNotification("textDocument/didOpen", {
			textDocument: { uri, languageId, version, text },
		});
		await this.evictIfNeeded();
	}

	async change(filePath: string, text: string, version: number): Promise<void> {
		const uri = this.uriFor(filePath);
		const prev = this.versions.get(uri) ?? 0;
		const next = Math.max(version, prev + 1);
		const base = this.texts.get(uri);
		// Equal text sends a full replacement, so the server still re-publishes for this version.
		const ranged =
			this.incrementalSync && base !== undefined ? rangedChange(base, text) : undefined;
		this.versions.set(uri, next);
		this.texts.set(uri, text);
		this.sentSeq.set(uri, this.seq);
		this.touchOpen(uri);
		this.connection.sendNotification("textDocument/didChange", {
			textDocument: { uri, version: next },
			contentChanges: [ranged ?? { text }],
		});
	}

	async close(filePath: string): Promise<void> {
		const uri = this.uriFor(filePath);
		const idx = this.openOrder.indexOf(uri);
		if (idx === -1) return;
		this.openOrder.splice(idx, 1);
		this.forget(uri);
		this.connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
	}

	private forget(uri: string): void {
		this.versions.delete(uri);
		this.openLanguage.delete(uri);
		this.diagnostics.delete(uri);
		this.texts.delete(uri);
		this.sentSeq.delete(uri);
	}

	openCount(): number {
		return this.openOrder.length;
	}

	/**
	 * Resolve with the diagnostics for `filePath` at `version` or later. A publish
	 * without a version (typescript-language-server) counts only when it arrived
	 * after the last didOpen/didChange, so the previous edit's cached result is
	 * never returned as fresh. A quiet window restarts on each new publish to merge
	 * phased publishes (syntax, then semantic). Reject on abort or child exit.
	 */
	waitForDiagnostics(
		filePath: string,
		version: number,
		waitMs: number,
		signal?: AbortSignal,
	): Promise<LspDiagnostic[] | undefined> {
		const uri = this.uriFor(filePath);
		const deadline = Date.now() + Math.max(1, waitMs);

		return new Promise<LspDiagnostic[] | undefined>((resolve, reject) => {
			let settleTimer: ReturnType<typeof setTimeout> | undefined;
			let seenSeq = -1;

			const cleanup = (): void => {
				this.waiters.delete(check);
				if (settleTimer) clearTimeout(settleTimer);
				clearTimeout(timeout);
				if (signal) signal.removeEventListener("abort", onAbort);
			};
			const onAbort = (): void => {
				cleanup();
				reject(new AbortError(`LSP ${this.serverId}: request aborted`));
			};

			const matches = (): PublishEvent | undefined => {
				const event = this.diagnostics.get(uri);
				if (!event) return undefined;
				const stale =
					event.version !== undefined
						? event.version < version
						: event.seq <= (this.sentSeq.get(uri) ?? 0);
				if (stale) return undefined;
				return event;
			};

			const finish = (): void => {
				cleanup();
				resolve(matches()?.diagnostics);
			};

			const check = (): void => {
				if (this.stateValue === "failed" || this.stateValue === "stopped") {
					cleanup();
					reject(new Error(`LSP ${this.serverId}: ${this.exitReason ?? "connection closed"}`));
					return;
				}
				const event = matches();
				if (event && event.seq !== seenSeq) {
					seenSeq = event.seq;
					// Quiet window: restart on each new publish, bounded by the deadline.
					const settle = Math.min(500, Math.max(250, Math.round(this.ewmaMs)));
					const remaining = deadline - Date.now();
					if (remaining <= 0) {
						finish();
						return;
					}
					if (settleTimer) clearTimeout(settleTimer);
					settleTimer = setTimeout(finish, Math.min(settle, remaining));
					settleTimer.unref?.();
					return;
				}
				if (Date.now() >= deadline && seenSeq < 0) {
					finish();
				}
			};

			if (signal) {
				if (signal.aborted) {
					reject(new AbortError(`LSP ${this.serverId}: request aborted`));
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.waiters.add(check);

			const timeout = setTimeout(
				() => {
					if (seenSeq < 0) finish();
				},
				Math.max(1, waitMs),
			);
			timeout.unref?.();

			check();
		});
	}

	async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) throw new AbortError(`LSP ${this.serverId}: request aborted`);
		const source = new CancellationTokenSource();
		// $/cancelRequest is advisory; reject locally so the caller is freed at once.
		let onAbort = (): void => {};
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => {
				source.cancel();
				reject(new AbortError(`LSP ${this.serverId}: request aborted`));
			};
		});
		aborted.catch(() => {});
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const reply = this.connection.sendRequest(method, params, source.token) as Promise<T>;
			return await withDeadline(
				Promise.race([reply, aborted]),
				this.requestTimeoutMs,
				`LSP ${this.serverId}: ${method}`,
				() => source.cancel(),
			);
		} finally {
			signal?.removeEventListener("abort", onAbort);
			source.dispose();
		}
	}

	isPullCapable(): boolean {
		return this.pullCapable;
	}

	updateEwma(elapsedMs: number): void {
		this.ewmaMs = this.ewmaMs === 0 ? elapsedMs : this.ewmaMs * 0.75 + elapsedMs * 0.25;
	}

	getEwma(): number {
		return this.ewmaMs;
	}

	state(): TransportState {
		return this.stateValue;
	}

	stderrTail(): string {
		return this.stderr;
	}

	async stop(): Promise<void> {
		if (this.stateValue === "stopped") return;
		this.stateValue = "stopped";
		try {
			await Promise.race([
				this.connection.sendRequest("shutdown"),
				new Promise((r) => setTimeout(r, 500)),
			]);
			this.connection.sendNotification("exit");
		} catch {
			/* server already gone */
		}
		await new Promise((r) => setTimeout(r, 500));
		this.cleanup();
	}

	private cleanup(): void {
		this.wakeWaiters();
		try {
			this.connection.dispose();
		} catch {
			/* already disposed */
		}
		if (this.child.exitCode === null && this.child.signalCode === null) {
			this.child.kill();
		}
	}
}
