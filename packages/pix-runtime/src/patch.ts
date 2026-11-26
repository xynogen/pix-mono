/**
 * Reversible in-memory patch of a Pi class method.
 *
 * Pi reloads extension modules, so a plain `proto.m = wrap(proto.m)` would stack
 * wrappers on every reload. The original is kept on the target under a symbol, and
 * each call wraps that original, so a reloaded module replaces the old wrapper.
 * Nothing is written to disk: without pix loaded, Pi runs its own method.
 */

// biome-ignore lint/suspicious/noExplicitAny: Pi methods have arbitrary signatures.
type Method = (this: any, ...args: any[]) => any;

/** Symbol under which `wrapMethod` keeps the original method on its target. */
export function nativeMethodKey(name: string): symbol {
	return Symbol.for(`@xynogen/pix-runtime:native:${name}`);
}

/**
 * Replace `target[name]` with `wrap(original)`. Returns false and changes nothing when
 * the host has no such method (a Pi release that renamed it keeps its own behaviour).
 * One wrapper per method: a second `wrapMethod` call for the same name replaces the first.
 */
export function wrapMethod(
	target: object,
	name: string,
	wrap: (native: Method) => Method,
): boolean {
	const key = nativeMethodKey(name);
	// Own property only: a parent prototype's saved original is not this method's.
	const native: unknown = Object.hasOwn(target, key)
		? Reflect.get(target, key)
		: Reflect.get(target, name);
	if (typeof native !== "function") return false;
	Reflect.set(target, key, native);
	Reflect.set(target, name, wrap(native as Method));
	return true;
}
