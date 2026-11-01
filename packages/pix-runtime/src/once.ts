/**
 * Per-instance idempotency guard for extension activation.
 *
 * pix-core (the meta-package) invokes this package's factory, and a standalone
 * install makes Pi invoke it again — sometimes against the SAME `pi`. We must
 * dedupe that. But Pi rebuilds the extension runtime on /new, /resume, /fork,
 * and /reload, handing the factory a BRAND-NEW `pi`; that must re-register.
 *
 * Keying the registry on the `pi` instance satisfies both: same instance =>
 * skip, new instance => run. The registry lives on globalThis because jiti
 * (`moduleCache: false`) re-evaluates this module on every load pass.
 */
type PackageHost = {
	events?: {
		emit(channel: string, data: unknown): void;
		on(channel: string, handler: (data: unknown) => void): unknown;
	};
};

const PACKAGE_QUERY = "pix:package-loaded";

/** Check after extension loading (for example, session_start), not factory order. */
export function isPackageLoaded(pi: PackageHost, key: string): boolean {
	const loaded = (globalThis as { __pixOnce?: WeakMap<object, Set<string>> }).__pixOnce;
	if (loaded?.get(pi)?.has(key)) return true;
	const query = { key, loaded: false };
	pi.events?.emit(PACKAGE_QUERY, query);
	return query.loaded;
}

export function once(pi: PackageHost, key: string, fn: () => void): void {
	const g = globalThis as { __pixOnce?: WeakMap<object, Set<string>> };
	if (!g.__pixOnce) g.__pixOnce = new WeakMap<object, Set<string>>();
	const registry = g.__pixOnce;
	let loaded = registry.get(pi);
	if (!loaded) {
		loaded = new Set<string>();
		registry.set(pi, loaded);
		pi.events?.on(PACKAGE_QUERY, (data) => {
			if (!data || typeof data !== "object" || !("key" in data) || !("loaded" in data)) return;
			if (typeof data.key === "string" && registry.get(pi)?.has(data.key)) {
				data.loaded = true;
			}
		});
	}
	if (loaded.has(key)) return;
	loaded.add(key);
	fn();
}
