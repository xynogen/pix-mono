/**
 * manager.ts — the one lazy, adaptive LSP manager.
 *
 * It starts no process until a visible tool call needs one. It keys live
 * servers by `${serverId}:${root}`, single-flights concurrent starts, shares one
 * server across files in one root, and stops a server after an idle window. It
 * caps live servers at four and evicts the least-recently-used idle one before a
 * fifth start. A per-key backoff throttles repeated failed starts.
 *
 * Process resolution, transport creation, file reads, the clock, and timers are
 * injected. Production wiring uses the registry, `LspTransport`, `node:fs`, and
 * real timers. Tests inject fakes and a fake clock.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import type { DiagnosticSnapshot, PixDiagnostic } from "../types.ts";
import {
	createResolver,
	type ResolvedLspServer,
	resolveServer as realResolveServer,
} from "./server-registry.ts";
import { type LspDiagnostic, LspTransport } from "./transport.ts";

export interface DiagnosticRequest {
	paths: readonly string[];
	waitMs?: number;
	severity: PixDiagnostic["severity"] | "all";
	signal?: AbortSignal;
}

export type NavigationOperation =
	| "definition"
	| "typeDefinition"
	| "implementation"
	| "references"
	| "hover"
	| "documentSymbol"
	| "workspaceSymbol"
	| "rename"
	| "callHierarchy";

export interface NavigationRequest {
	operation: NavigationOperation;
	path?: string;
	line?: number;
	character?: number;
	symbol?: string;
	query?: string;
	newName?: string;
	direction?: "incoming" | "outgoing";
	limit: number;
	signal?: AbortSignal;
}

export interface NavigationLocation {
	kind: "location";
	filePath: string;
	line: number;
	character: number;
	endLine?: number;
	endCharacter?: number;
}

export interface NavigationHover {
	kind: "hover";
	text: string;
}

export interface NavigationSymbol {
	kind: "symbol";
	name: string;
	symbolKind: number;
	filePath?: string;
	line?: number;
	character?: number;
}

export interface NavigationEdit {
	kind: "edit";
	filePath: string;
	line: number;
	character: number;
	endLine: number;
	endCharacter: number;
	newText: string;
}

export interface NavigationCall {
	kind: "call";
	name: string;
	filePath: string;
	line: number;
	character: number;
}

export type NavigationResult =
	| NavigationLocation
	| NavigationHover
	| NavigationSymbol
	| NavigationEdit
	| NavigationCall;

export interface LspManager {
	check(request: DiagnosticRequest): Promise<DiagnosticSnapshot[]>;
	navigate(request: NavigationRequest): Promise<NavigationResult[]>;
	activeServerIds(): string[];
	shutdown(): Promise<void>;
}

// ─── Injectable seams ──────────────────────────────────────────────────────

/** Subset of `LspTransport` the manager uses. */
export interface TransportLike {
	open(filePath: string, languageId: string, text: string, version: number): Promise<void>;
	change(filePath: string, text: string, version: number): Promise<void>;
	waitForDiagnostics(
		filePath: string,
		version: number,
		waitMs: number,
		signal?: AbortSignal,
	): Promise<LspDiagnostic[] | undefined>;
	request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
	isPullCapable(): boolean;
	updateEwma(ms: number): void;
	getEwma(): number;
	state(): "starting" | "ready" | "failed" | "stopped";
	stderrTail(): string;
	stop(): Promise<void>;
}

export type ResolveResult =
	| { kind: "ok"; resolved: ResolvedLspServer }
	| { kind: "no-server" }
	| { kind: "no-executable"; commands: readonly string[] };

/**
 * Opaque timer handle. Production returns a `setTimeout` handle; tests return a
 * counter id. The manager only stores and hands it back to `clearTimer`, so an
 * empty marker interface is the honest shape here.
 */
export interface TimerHandle {
	readonly __timer?: unique symbol;
}

export interface ManagerDeps {
	resolve(filePath: string): Promise<ResolveResult>;
	start(resolved: ResolvedLspServer): Promise<TransportLike>;
	readFile(filePath: string): Promise<string>;
	now(): number;
	setTimer(fn: () => void, ms: number): TimerHandle;
	clearTimer(handle: TimerHandle): void;
}

const MAX_LIVE_SERVERS = 4;
const IDLE_MS = 5 * 60 * 1000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

class AbortError extends Error {
	override name = "AbortError";
}

interface ManagedServer {
	key: string;
	resolved: ResolvedLspServer;
	transport: TransportLike;
	lastUsed: number;
	busy: number;
	idleTimer?: TimerHandle;
	versions: Map<string, number>;
}

interface BackoffState {
	until: number;
	attempts: number;
}

const SEVERITY_MAP: Record<number, PixDiagnostic["severity"]> = {
	1: "error",
	2: "warning",
	3: "information",
	4: "hint",
};

function keyFor(serverId: string, root: string): string {
	return `${serverId}:${root}`;
}

/** Await a promise but reject early when a signal aborts. Does not reject `p`. */
function awaitWithSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return p;
	if (signal.aborted) return Promise.reject(new AbortError("aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(new AbortError("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

class LazyLspManager implements LspManager {
	private readonly live = new Map<string, ManagedServer>();
	private readonly starting = new Map<string, Promise<ManagedServer>>();
	private readonly backoff = new Map<string, BackoffState>();
	private readonly idleMs: number;

	constructor(
		private readonly deps: ManagerDeps,
		options: { idleMs?: number } = {},
	) {
		this.idleMs = options.idleMs ?? IDLE_MS;
	}

	activeServerIds(): string[] {
		return [...this.live.values()].map((s) => s.resolved.spec.id);
	}

	async check(request: DiagnosticRequest): Promise<DiagnosticSnapshot[]> {
		const now = this.deps.now();
		// Group requested paths by their resolved server key.
		const groups = new Map<string, { resolved: ResolvedLspServer; paths: string[] }>();
		const snapshots: DiagnosticSnapshot[] = [];

		for (const path of request.paths) {
			const result = await this.deps.resolve(path);
			if (result.kind === "no-server") {
				snapshots.push({
					filePath: path,
					diagnostics: [],
					checkedAt: now,
					state: "unavailable",
					reason: "no language server for this file type",
				});
				continue;
			}
			if (result.kind === "no-executable") {
				snapshots.push({
					filePath: path,
					diagnostics: [],
					checkedAt: now,
					state: "unavailable",
					reason: `install one of: ${result.commands.join(", ")}`,
				});
				continue;
			}
			const key = keyFor(result.resolved.spec.id, result.resolved.root);
			const group = groups.get(key) ?? { resolved: result.resolved, paths: [] };
			group.paths.push(path);
			groups.set(key, group);
		}

		const pending: Promise<void>[] = [];
		for (const [key, group] of groups.entries()) {
			pending.push(this.checkGroup(key, group, request, snapshots));
		}
		await Promise.all(pending);

		return snapshots;
	}

	private async checkGroup(
		key: string,
		group: { resolved: ResolvedLspServer; paths: string[] },
		request: DiagnosticRequest,
		snapshots: DiagnosticSnapshot[],
	): Promise<void> {
		const acquired = await this.acquire(key, group.resolved, request.signal);
		if ("unavailable" in acquired) {
			for (const path of group.paths) {
				snapshots.push({
					filePath: path,
					diagnostics: [],
					checkedAt: this.deps.now(),
					state: "unavailable",
					serverId: group.resolved.spec.id,
					reason: acquired.unavailable,
				});
			}
			return;
		}
		const server = acquired.server;
		server.busy++;
		this.clearIdle(server);
		try {
			for (const path of group.paths) {
				snapshots.push(await this.checkOne(server, path, request));
			}
		} finally {
			server.busy--;
			server.lastUsed = this.deps.now();
			if (server.busy === 0) this.scheduleIdle(server);
		}
	}

	private async checkOne(
		server: ManagedServer,
		path: string,
		request: DiagnosticRequest,
	): Promise<DiagnosticSnapshot> {
		const started = this.deps.now();
		const text = await this.deps.readFile(path);
		const version = (server.versions.get(path) ?? 0) + 1;
		server.versions.set(path, version);
		const languageId = server.resolved.spec.languageId(path);
		await server.transport.open(path, languageId, text, version);

		const waitMs =
			request.waitMs ??
			Math.min(10_000, Math.max(2_000, Math.round(server.transport.getEwma() * 4)));

		const raw = await server.transport.waitForDiagnostics(path, version, waitMs, request.signal);
		server.transport.updateEwma(this.deps.now() - started);

		const diagnostics: PixDiagnostic[] = (raw ?? []).map((d) => ({
			filePath: path,
			severity: SEVERITY_MAP[d.severity] ?? "error",
			message: d.message,
			line: d.line + 1,
			column: d.character + 1,
			endLine: d.endLine + 1,
			endColumn: d.endCharacter + 1,
			source: d.source,
			code: d.code,
		}));

		// Push-only server that never published: report unconfirmed, not clean.
		const gotEvent = raw !== undefined;
		const state: DiagnosticSnapshot["state"] =
			diagnostics.length > 0 ? "findings" : gotEvent ? "clean" : "unconfirmed";

		return {
			filePath: path,
			diagnostics,
			checkedAt: this.deps.now(),
			state,
			serverId: server.resolved.spec.id,
			reason:
				state === "unconfirmed" ? "server sent no diagnostics before the wait budget" : undefined,
		};
	}

	async navigate(request: NavigationRequest): Promise<NavigationResult[]> {
		if (request.operation === "workspaceSymbol") {
			const servers = [...this.live.values()];
			const results: NavigationResult[] = [];
			for (const server of servers) {
				server.busy++;
				this.clearIdle(server);
				try {
					const raw = await server.transport.request<unknown>(
						"workspace/symbol",
						{ query: request.query ?? "" },
						request.signal,
					);
					results.push(...mapSymbols(raw));
				} finally {
					server.busy--;
					server.lastUsed = this.deps.now();
					if (server.busy === 0) this.scheduleIdle(server);
				}
				if (results.length >= request.limit) break;
			}
			return results.slice(0, request.limit);
		}

		if (!request.path) return [];
		const resolved = await this.deps.resolve(request.path);
		if (resolved.kind !== "ok") return [];
		const key = keyFor(resolved.resolved.spec.id, resolved.resolved.root);
		const acquired = await this.acquire(key, resolved.resolved, request.signal);
		if ("unavailable" in acquired) return [];
		const server = acquired.server;
		server.busy++;
		this.clearIdle(server);
		try {
			// Send current file text before the request so the server sees fresh state.
			const text = await this.deps.readFile(request.path);
			const version = (server.versions.get(request.path) ?? 0) + 1;
			server.versions.set(request.path, version);
			await server.transport.open(
				request.path,
				server.resolved.spec.languageId(request.path),
				text,
				version,
			);

			if (request.operation === "rename") {
				const params = {
					textDocument: { uri: pathToUri(request.path) },
					position: { line: (request.line ?? 1) - 1, character: (request.character ?? 1) - 1 },
					newName: request.newName ?? "",
				};
				const raw = await server.transport.request<unknown>(
					"textDocument/rename",
					params,
					request.signal,
				);
				return mapWorkspaceEdit(raw).slice(0, request.limit);
			}
			if (request.operation === "callHierarchy") {
				const calls = await this.callHierarchy(server, request);
				return calls.slice(0, request.limit);
			}
			const method = methodFor(request.operation);
			const params = buildParams(request);
			const raw = await server.transport.request<unknown>(method, params, request.signal);
			return mapNavigation(request.operation, raw).slice(0, request.limit);
		} finally {
			server.busy--;
			server.lastUsed = this.deps.now();
			if (server.busy === 0) this.scheduleIdle(server);
		}
	}

	/** Prepare a call-hierarchy item, then fetch incoming or outgoing calls. */
	private async callHierarchy(
		server: ManagedServer,
		request: NavigationRequest,
	): Promise<NavigationResult[]> {
		const prepare = await server.transport.request<unknown>(
			"textDocument/prepareCallHierarchy",
			{
				textDocument: { uri: pathToUri(request.path ?? "") },
				position: { line: (request.line ?? 1) - 1, character: (request.character ?? 1) - 1 },
			},
			request.signal,
		);
		const items = Array.isArray(prepare) ? prepare : [];
		const first = items[0];
		if (!first) return [];
		const outgoing = request.direction === "outgoing";
		const method = outgoing ? "callHierarchy/outgoingCalls" : "callHierarchy/incomingCalls";
		const raw = await server.transport.request<unknown>(method, { item: first }, request.signal);
		return mapCalls(raw, outgoing);
	}

	private async acquire(
		key: string,
		resolved: ResolvedLspServer,
		signal?: AbortSignal,
	): Promise<{ server: ManagedServer } | { unavailable: string }> {
		const existing = this.live.get(key);
		if (existing) {
			this.clearIdle(existing);
			return { server: existing };
		}

		const back = this.backoff.get(key);
		if (back && this.deps.now() < back.until) {
			return { unavailable: `retry in ${Math.ceil((back.until - this.deps.now()) / 1000)}s` };
		}

		let pending = this.starting.get(key);
		if (!pending) {
			// Cap live servers. Evict an idle server, or refuse when all are busy.
			if (this.live.size >= MAX_LIVE_SERVERS) {
				const evicted = await this.evictIdle();
				if (!evicted) return { unavailable: "all language servers busy, try again shortly" };
			}
			pending = this.startServer(key, resolved);
			this.starting.set(key, pending);
		}

		try {
			const server = await awaitWithSignal(pending, signal);
			return { server };
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw error;
			return { unavailable: getErrorMessage(error) };
		}
	}

	private startServer(key: string, resolved: ResolvedLspServer): Promise<ManagedServer> {
		const promise = (async (): Promise<ManagedServer> => {
			const transport = await this.deps.start(resolved);
			const server: ManagedServer = {
				key,
				resolved,
				transport,
				lastUsed: this.deps.now(),
				busy: 0,
				versions: new Map(),
			};
			this.live.set(key, server);
			this.starting.delete(key);
			this.backoff.delete(key);
			// If no caller kept it busy, it enters the idle lifecycle at once.
			this.scheduleIdle(server);
			return server;
		})().catch((error) => {
			this.starting.delete(key);
			const prev = this.backoff.get(key);
			const attempts = (prev?.attempts ?? 0) + 1;
			const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (attempts - 1));
			this.backoff.set(key, { until: this.deps.now() + delay, attempts });
			throw error;
		});
		return promise;
	}

	private async evictIdle(): Promise<boolean> {
		let victim: ManagedServer | undefined;
		for (const server of this.live.values()) {
			if (server.busy > 0) continue;
			if (!victim || server.lastUsed < victim.lastUsed) victim = server;
		}
		if (!victim) return false;
		await this.stopServer(victim);
		return true;
	}

	private clearIdle(server: ManagedServer): void {
		if (server.idleTimer !== undefined) {
			this.deps.clearTimer(server.idleTimer);
			server.idleTimer = undefined;
		}
	}

	private scheduleIdle(server: ManagedServer): void {
		this.clearIdle(server);
		server.idleTimer = this.deps.setTimer(() => {
			if (server.busy === 0) void this.stopServer(server);
		}, this.idleMs);
	}

	private async stopServer(server: ManagedServer): Promise<void> {
		this.clearIdle(server);
		this.live.delete(server.key);
		await server.transport.stop();
	}

	async shutdown(): Promise<void> {
		for (const server of this.live.values()) this.clearIdle(server);
		const transports = [...this.live.values()].map((s) => s.transport);
		this.live.clear();
		this.starting.clear();
		this.backoff.clear();
		await Promise.allSettled(transports.map((t) => t.stop()));
	}
}

// ─── LSP result mapping ──────────────────────────────────────────────────────

export function methodFor(operation: NavigationOperation): string {
	switch (operation) {
		case "definition":
			return "textDocument/definition";
		case "typeDefinition":
			return "textDocument/typeDefinition";
		case "implementation":
			return "textDocument/implementation";
		case "references":
			return "textDocument/references";
		case "hover":
			return "textDocument/hover";
		case "documentSymbol":
			return "textDocument/documentSymbol";
		case "workspaceSymbol":
			return "workspace/symbol";
		case "rename":
			return "textDocument/rename";
		case "callHierarchy":
			return "textDocument/prepareCallHierarchy";
		default:
			throw new Error(`unknown navigation operation: ${operation as string}`);
	}
}

interface LspRequestParams {
	textDocument: { uri: string };
	position?: { line: number; character: number };
	context?: { includeDeclaration: boolean };
}

function buildParams(request: NavigationRequest): LspRequestParams {
	const uri = request.path ? pathToUri(request.path) : "";
	const position = {
		line: (request.line ?? 1) - 1,
		character: (request.character ?? 1) - 1,
	};
	if (request.operation === "documentSymbol") {
		return { textDocument: { uri } };
	}
	if (request.operation === "references") {
		return { textDocument: { uri }, position, context: { includeDeclaration: true } };
	}
	return { textDocument: { uri }, position };
}

function pathToUri(filePath: string): string {
	try {
		return new URL(`file://${filePath}`).href;
	} catch {
		return `file://${filePath}`;
	}
}

interface RawLocation {
	uri?: string;
	targetUri?: string;
	range?: { start: { line: number; character: number }; end: { line: number; character: number } };
	targetRange?: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

function uriToPath(uri: string): string {
	try {
		return fileURLToPath(uri);
	} catch {
		return uri.replace(/^file:\/\//, "");
	}
}

function mapLocation(loc: RawLocation): NavigationLocation | undefined {
	const uri = loc.uri ?? loc.targetUri;
	const range = loc.range ?? loc.targetRange;
	if (!uri || !range) return undefined;
	return {
		kind: "location",
		filePath: uriToPath(uri),
		line: range.start.line + 1,
		character: range.start.character + 1,
		endLine: range.end.line + 1,
		endCharacter: range.end.character + 1,
	};
}

function mapSymbols(raw: unknown): NavigationSymbol[] {
	if (!Array.isArray(raw)) return [];
	const out: NavigationSymbol[] = [];
	for (const item of raw as Array<Record<string, unknown>>) {
		const name = typeof item.name === "string" ? item.name : undefined;
		if (!name) continue;
		const loc = (item.location ?? item) as RawLocation;
		const mapped = loc.uri && loc.range ? mapLocation(loc) : undefined;
		out.push({
			kind: "symbol",
			name,
			symbolKind: typeof item.kind === "number" ? item.kind : 0,
			filePath: mapped?.filePath,
			line: mapped?.line,
			character: mapped?.character,
		});
	}
	return out;
}

function hoverText(raw: unknown): string {
	const contents = (raw as { contents?: unknown } | null)?.contents;
	if (contents == null) return "";
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) {
		return contents
			.map((c) => (typeof c === "string" ? c : ((c as { value?: string })?.value ?? "")))
			.join("\n");
	}
	return (contents as { value?: string }).value ?? "";
}

interface RawWorkspaceEdit {
	changes?: Record<string, RawTextEdit[]>;
	documentChanges?: Array<{ textDocument?: { uri?: string }; edits?: RawTextEdit[] }>;
}
interface RawTextEdit {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	newText: string;
}

/** Flatten a WorkspaceEdit (from rename) into one NavigationEdit per text edit. */
export function mapWorkspaceEdit(raw: unknown): NavigationEdit[] {
	const edit = (raw ?? {}) as RawWorkspaceEdit;
	const out: NavigationEdit[] = [];
	const push = (uri: string, edits: RawTextEdit[] | undefined): void => {
		for (const e of edits ?? []) {
			out.push({
				kind: "edit",
				filePath: uriToPath(uri),
				line: e.range.start.line + 1,
				character: e.range.start.character + 1,
				endLine: e.range.end.line + 1,
				endCharacter: e.range.end.character + 1,
				newText: e.newText,
			});
		}
	};
	if (edit.changes) {
		for (const [uri, edits] of Object.entries(edit.changes)) push(uri, edits);
	}
	for (const dc of edit.documentChanges ?? []) push(dc.textDocument?.uri ?? "", dc.edits);
	return out;
}

interface RawCallItem {
	from?: { name?: string; uri?: string; range?: RawTextEdit["range"] };
	to?: { name?: string; uri?: string; range?: RawTextEdit["range"] };
}

/** Map incoming/outgoing call items into NavigationCall results. */
export function mapCalls(raw: unknown, outgoing: boolean): NavigationCall[] {
	if (!Array.isArray(raw)) return [];
	const out: NavigationCall[] = [];
	for (const item of raw as RawCallItem[]) {
		const node = outgoing ? item.to : item.from;
		if (!node?.name || !node.uri || !node.range) continue;
		out.push({
			kind: "call",
			name: node.name,
			filePath: uriToPath(node.uri),
			line: node.range.start.line + 1,
			character: node.range.start.character + 1,
		});
	}
	return out;
}

export function mapNavigation(operation: NavigationOperation, raw: unknown): NavigationResult[] {
	if (operation === "hover") {
		const text = hoverText(raw);
		return text ? [{ kind: "hover", text }] : [];
	}
	if (operation === "documentSymbol" || operation === "workspaceSymbol") {
		return mapSymbols(raw);
	}
	const items: RawLocation[] = Array.isArray(raw) ? raw : raw ? [raw as RawLocation] : [];
	return items.map(mapLocation).filter((x): x is NavigationLocation => x !== undefined);
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/** Production manager wired to the registry, transport, fs, and real timers. */
export function createManager(cwd: string, options: { idleMs?: number } = {}): LspManager {
	const resolver = createResolver(cwd);
	const deps: ManagerDeps = {
		async resolve(filePath) {
			const spec = resolver.specFor(filePath);
			if (!spec) return { kind: "no-server" };
			const root = await resolver.rootFor(filePath, spec);
			const resolved = await realResolveServer(spec, root);
			if (!resolved) return { kind: "no-executable", commands: spec.commands };
			return { kind: "ok", resolved };
		},
		async start(resolved) {
			return LspTransport.start({
				command: resolved.command,
				args: [...resolved.spec.args],
				cwd: resolved.root,
				rootUri: pathToUri(resolved.root),
				serverId: resolved.spec.id,
			});
		},
		readFile: (filePath) => readFile(filePath, "utf8"),
		now: () => Date.now(),
		setTimer: (fn, ms) => {
			const handle = setTimeout(fn, ms);
			handle.unref?.();
			// SAFETY: TimerHandle is an opaque marker; the manager only stores this
			// value and returns it to clearTimer below. It never reads its shape.
			return handle as unknown as TimerHandle;
		},
		// SAFETY: handle is exactly the setTimeout return produced by setTimer above.
		clearTimer: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
	};
	return new LazyLspManager(deps, options);
}

/** Test/advanced entry point with fully injected dependencies. */
export function createManagerWith(
	deps: ManagerDeps,
	options: { idleMs?: number } = {},
): LspManager {
	return new LazyLspManager(deps, options);
}
