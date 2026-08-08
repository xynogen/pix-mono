/**
 * runtime.ts — the process singleton and PixRuntime implementation.
 *
 * One runtime per JavaScript process, stored under a globalThis symbol so
 * duplicate compatible npm copies share one write queue. Reads are synchronous
 * after a lazy load; writes are serialized and atomic.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DiagnosticSink } from "./diagnostics.ts";
import {
	type ConfigChange,
	type ConfigChangeOrigin,
	type ConfigListener,
	type ConfigSnapshot,
	EventBus,
	makeSnapshot,
	type SubscribeOptions,
} from "./events.ts";
import { importOptimizerSidecar, migrate } from "./migrations.ts";
import {
	ConfigWriteError,
	FileStorage,
	parseRawDocument,
	type StorageAdapter,
	serializeRawDocument,
	WriteQueue,
} from "./persistence.ts";
import { SectionRegistry } from "./registry.ts";
import {
	CONFIG_FORMAT_VERSION,
	type ConfigDiagnostic,
	clone,
	type DeepPartial,
	deepMerge,
	diffPaths,
	isObj,
	type ParseContext,
	type RawDocument,
	type SectionHandle,
	stripDefaults,
} from "./schema.ts";

export interface InitOptions {
	origin?: ConfigChangeOrigin;
	source?: string;
}

export interface UpdateOptions {
	origin?: ConfigChangeOrigin;
	source?: string;
}

export interface ReloadOptions {
	origin?: ConfigChangeOrigin;
	source?: string;
}

export interface RuntimeAdapters {
	agentDir?: string;
	storage?: StorageAdapter;
	registry?: SectionRegistry;
}

export interface PixRuntime {
	readonly path: string;
	readonly ready: boolean;
	init(options?: InitOptions): Promise<ConfigSnapshot>;
	flush(): Promise<void>;
	shutdown(): Promise<void>;
	snapshot(): ConfigSnapshot;
	get<K extends string, T>(section: SectionHandle<K, T>): Readonly<T>;
	update<K extends string, T>(
		section: SectionHandle<K, T>,
		updater: DeepPartial<T> | ((current: Readonly<T>) => T),
		options?: UpdateOptions,
	): Promise<ConfigChange | undefined>;
	reset<K extends string, T>(
		section: SectionHandle<K, T>,
		paths?: readonly string[],
		options?: UpdateOptions,
	): Promise<ConfigChange | undefined>;
	reload(options?: ReloadOptions): Promise<ConfigChange | undefined>;
	subscribe(listener: ConfigListener, options?: SubscribeOptions): () => void;
	diagnostics(): readonly ConfigDiagnostic[];
}

class RuntimeImpl implements PixRuntime {
	private readonly storage: StorageAdapter;
	private readonly registry: SectionRegistry;
	private readonly queue = new WriteQueue();
	private readonly bus = new EventBus();
	private readonly sink = new DiagnosticSink();

	private revision = 0;
	private current: ConfigSnapshot | null = null;
	private readonly agentDir: string;
	private initPromise: Promise<ConfigSnapshot> | null = null;
	private readOnly = false;

	constructor(adapters: RuntimeAdapters = {}) {
		this.agentDir = adapters.agentDir ?? getAgentDir();
		this.storage = adapters.storage ?? new FileStorage(this.agentDir);
		this.registry = adapters.registry ?? new SectionRegistry();
	}

	get path(): string {
		return this.storage.path;
	}

	get ready(): boolean {
		return this.current !== null;
	}

	private parseContext(): ParseContext {
		return { diagnostic: (d) => this.sink.push(d) };
	}

	/** Resolve every section from a raw document into a values map. */
	private resolve(doc: RawDocument): Map<string, unknown> {
		const ctx = this.parseContext();
		const values = new Map<string, unknown>();
		for (const section of this.registry.all()) {
			values.set(section.key, section.parse(doc[section.key], ctx));
		}
		return values;
	}

	private publish(values: Map<string, unknown>): ConfigSnapshot {
		this.revision += 1;
		this.current = makeSnapshot(this.revision, values);
		return this.current;
	}

	/** Synchronous lazy load — read-only, never migrates or writes. */
	private lazyLoad(): ConfigSnapshot {
		if (this.current) return this.current;
		let doc: RawDocument = {};
		try {
			doc = parseRawDocument(this.storage.readRaw());
		} catch (err) {
			this.sink.push({
				code: "READ_FAILED",
				severity: "warning",
				message: "config read failed; using defaults",
				cause: err,
			});
		}
		return this.publish(this.resolve(doc));
	}

	snapshot(): ConfigSnapshot {
		return this.current ?? this.lazyLoad();
	}

	get<K extends string, T>(section: SectionHandle<K, T>): Readonly<T> {
		return this.snapshot().get(section);
	}

	diagnostics(): readonly ConfigDiagnostic[] {
		return this.sink.all();
	}

	subscribe(listener: ConfigListener, options: SubscribeOptions = {}): () => void {
		const unsub = this.bus.subscribe({ listener, paths: options.paths });
		if (options.immediate) {
			listener({
				revision: this.revision,
				origin: "init",
				changed: [],
				current: this.snapshot(),
				persisted: false,
			});
		}
		return unsub;
	}

	/** Single-flight initialization: migrate, import sidecars, publish. */
	init(options: InitOptions = {}): Promise<ConfigSnapshot> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = this.queue.run(async () => {
			const hadLazy = this.current !== null;
			const previous = this.current;
			this.storage.ensureDir();
			const doc = parseRawDocument(this.storage.readRaw());
			const ctx = this.parseContext();

			const migrated = migrate(doc, ctx);
			this.readOnly = migrated.document.$version !== CONFIG_FORMAT_VERSION;

			let working = migrated.document;
			let needsWrite = migrated.changed;
			let archive: (() => void) | undefined;

			if (!this.readOnly) {
				const sidecar = importOptimizerSidecar(working, this.agentDir, ctx);
				if (sidecar.changed) needsWrite = true;
				archive = sidecar.archive;
			}

			if (needsWrite && !this.readOnly) {
				try {
					this.persist(working);
					archive?.();
				} catch (err) {
					this.sink.push({
						code: "WRITE_FAILED",
						severity: "error",
						message: "initial migration write failed",
						cause: err,
					});
				}
			} else if (this.readOnly) {
				working = doc; // do not normalize a future-version file
			}

			const values = this.resolve(working);
			const snapshot = this.publish(values);

			if (previous) {
				const changed = this.changedPaths(previous, snapshot);
				if (changed.length > 0) {
					this.dispatch({
						revision: this.revision,
						origin: hadLazy ? "migration" : (options.origin ?? "init"),
						source: options.source,
						changed,
						previous,
						current: snapshot,
						persisted: needsWrite,
					});
				}
			} else {
				this.dispatch({
					revision: this.revision,
					origin: options.origin ?? "init",
					source: options.source,
					changed: [],
					current: snapshot,
					persisted: needsWrite,
				});
			}
			return snapshot;
		});
		return this.initPromise;
	}

	/** Serialize the current resolved values into a sparse raw document. */
	private buildRawFromValues(values: Map<string, unknown>, base: RawDocument): RawDocument {
		const doc: RawDocument = { ...base, $version: CONFIG_FORMAT_VERSION };
		for (const section of this.registry.all()) {
			const value = values.get(section.key);
			const serialized = section.serialize
				? section.serialize(value, section.defaults)
				: this.defaultStrip(value, section.defaults);
			if (serialized === undefined) delete doc[section.key];
			else doc[section.key] = serialized;
		}
		return doc;
	}

	private defaultStrip(value: unknown, defaults: unknown): unknown {
		if (!isObj(value) || !isObj(defaults)) {
			return JSON.stringify(value) === JSON.stringify(defaults) ? undefined : value;
		}
		const copy = { ...value };
		return stripDefaults(copy, defaults) > 0 ? copy : undefined;
	}

	private persist(doc: RawDocument): void {
		this.storage.writeAtomic(serializeRawDocument(doc));
	}

	private changedPaths(prev: ConfigSnapshot, next: ConfigSnapshot): string[] {
		const out: string[] = [];
		for (const section of this.registry.all()) {
			const handle = { key: section.key, defaults: section.defaults, __section: section };
			out.push(...diffPaths(section.key, prev.get(handle as never), next.get(handle as never)));
		}
		return out;
	}

	private dispatch(change: ConfigChange): void {
		this.bus.emit(change, (err) =>
			this.sink.push({
				code: "LISTENER_FAILED",
				severity: "warning",
				message: "config listener threw",
				cause: err,
			}),
		);
	}

	update<K extends string, T>(
		section: SectionHandle<K, T>,
		updater: DeepPartial<T> | ((current: Readonly<T>) => T),
		options: UpdateOptions = {},
	): Promise<ConfigChange | undefined> {
		return this.queue.run(async () => this.commit(section, updater, options, "api"));
	}

	reset<K extends string, T>(
		section: SectionHandle<K, T>,
		paths?: readonly string[],
		options: UpdateOptions = {},
	): Promise<ConfigChange | undefined> {
		return this.queue.run(async () => {
			// Full reset to defaults, or per-path restore. Always a function
			// updater so defaults *replace* rather than deep-merge onto current.
			const updater = (current: Readonly<T>): T => {
				if (!paths || paths.length === 0) return clone(section.defaults) as T;
				const next = clone(current) as Record<string, unknown>;
				const defs = section.defaults as Record<string, unknown>;
				for (const p of paths) {
					const key = p.startsWith(`${section.key}.`) ? p.slice(section.key.length + 1) : p;
					if (key in defs) next[key] = clone(defs[key]);
				}
				return next as T;
			};
			return this.commit(section, updater, options, "api");
		});
	}

	/** Core transaction: read latest on-disk, apply update, persist, publish. */
	private commit<K extends string, T>(
		section: SectionHandle<K, T>,
		updater: DeepPartial<T> | ((current: Readonly<T>) => T),
		options: UpdateOptions,
		defaultOrigin: ConfigChangeOrigin,
	): ConfigChange | undefined {
		if (this.readOnly) {
			this.sink.push({
				code: "UNSUPPORTED_CONFIG_VERSION",
				severity: "error",
				path: section.key,
				message: "config is read-only (newer $version)",
			});
			return undefined;
		}

		const previous = this.snapshot();
		const base = parseRawDocument(this.storage.readRaw());
		const ctx = this.parseContext();

		// Re-resolve all sections from the latest on-disk doc so unknown fields
		// and sibling sections survive.
		const values = new Map<string, unknown>();
		for (const s of this.registry.all()) values.set(s.key, s.parse(base[s.key], ctx));

		// Guard against a version-skewed second runtime copy whose registry
		// lacks this section (e.g. an old npm copy handling a new handle). The
		// functional updater would otherwise crash the whole process on
		// `undefined`. Fall back to the handle's own parse of the raw doc.
		const currentValue = (
			values.has(section.key)
				? values.get(section.key)
				: section.__section.parse(base[section.key], ctx)
		) as Readonly<T>;
		const mergedValue =
			typeof updater === "function"
				? (updater as (c: Readonly<T>) => T)(currentValue)
				: deepMerge(currentValue as T, updater);

		// Re-validate through the section's own parse so a bad patch (NaN,
		// Infinity, wrong type) can never enter the live snapshot.
		const nextValue = section.__section.parse(mergedValue, ctx) as T;

		if (JSON.stringify(currentValue) === JSON.stringify(nextValue)) return undefined;
		values.set(section.key, nextValue);

		const doc = this.buildRawFromValues(values, base);
		try {
			this.persist(doc);
		} catch (err) {
			this.sink.push({
				code: "WRITE_FAILED",
				severity: "error",
				path: section.key,
				message: "config write failed; snapshot unchanged",
				cause: err,
			});
			if (err instanceof ConfigWriteError) return undefined;
			return undefined;
		}

		const snapshot = this.publish(values);
		const change: ConfigChange = {
			revision: this.revision,
			origin: options.origin ?? defaultOrigin,
			source: options.source,
			changed: this.changedPaths(previous, snapshot),
			previous,
			current: snapshot,
			persisted: true,
		};
		if (change.changed.length === 0) return undefined;
		this.dispatch(change);
		return change;
	}

	reload(options: ReloadOptions = {}): Promise<ConfigChange | undefined> {
		return this.queue.run(async () => {
			const previous = this.snapshot();
			const doc = parseRawDocument(this.storage.readRaw());
			const values = this.resolve(doc);
			const snapshot = this.publish(values);
			const changed = this.changedPaths(previous, snapshot);
			if (changed.length === 0) return undefined;
			const change: ConfigChange = {
				revision: this.revision,
				origin: options.origin ?? "reload",
				source: options.source,
				changed,
				previous,
				current: snapshot,
				persisted: false,
			};
			this.dispatch(change);
			return change;
		});
	}

	flush(): Promise<void> {
		// All writes are synchronous inside queued tasks; draining the queue
		// guarantees pending transactions have settled.
		return this.queue.run(async () => undefined);
	}

	async shutdown(): Promise<void> {
		await this.flush();
		this.bus.clear();
	}
}

// ── Process singleton ────────────────────────────────────────────────────────

const SINGLETON_KEY = Symbol.for("@xynogen/pix-runtime");

interface Global {
	[SINGLETON_KEY]?: PixRuntime;
}

export function pixRuntime(): PixRuntime {
	const g = globalThis as Global;
	if (!g[SINGLETON_KEY]) g[SINGLETON_KEY] = new RuntimeImpl();
	return g[SINGLETON_KEY];
}

/** Test/entry hook: create an isolated runtime with injected adapters. */
export function createRuntime(adapters: RuntimeAdapters = {}): PixRuntime {
	return new RuntimeImpl(adapters);
}

// ── Convenience delegates ────────────────────────────────────────────────────

export function config<K extends string, T>(section: SectionHandle<K, T>): Readonly<T> {
	return pixRuntime().get(section);
}

export function updateConfig<K extends string, T>(
	section: SectionHandle<K, T>,
	patch: DeepPartial<T> | ((current: Readonly<T>) => T),
	options?: UpdateOptions,
): Promise<ConfigChange | undefined> {
	return pixRuntime().update(section, patch, options);
}

export function onConfigChange(listener: ConfigListener, options?: SubscribeOptions): () => void {
	return pixRuntime().subscribe(listener, options);
}

export function reloadConfig(options?: ReloadOptions): Promise<ConfigChange | undefined> {
	return pixRuntime().reload(options);
}
