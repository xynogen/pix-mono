/**
 * registry.ts — internal built-in section registry.
 *
 * V1 keeps registration internal: there is no public `registerSection()` until
 * a real optional-package use case proves its lifecycle. Duplicate keys fail at
 * construction. Unknown raw sections are preserved elsewhere (persistence), so
 * this closed set does not block forward compatibility.
 */

import type { ConfigSection, SectionHandle } from "./schema.ts";
import { builtinSections } from "./sections/index.ts";

export class SectionRegistry {
	private readonly byKey = new Map<string, ConfigSection<unknown>>();

	constructor(handles: readonly SectionHandle<string, unknown>[] = builtinSections) {
		for (const handle of handles) this.add(handle);
	}

	private add(handle: SectionHandle<string, unknown>): void {
		if (this.byKey.has(handle.key)) {
			throw new Error(`pix-runtime: duplicate section key "${handle.key}"`);
		}
		this.byKey.set(handle.key, handle.__section);
	}

	get(key: string): ConfigSection<unknown> | undefined {
		return this.byKey.get(key);
	}

	/**
	 * Swap in a newer definition for a known key (Pi reload re-evaluates modules, but the
	 * runtime singleton on globalThis survives with the old schema). True when it changed.
	 */
	adopt(handle: SectionHandle<string, unknown>): boolean {
		if (!this.byKey.has(handle.key) || this.byKey.get(handle.key) === handle.__section)
			return false;
		this.byKey.set(handle.key, handle.__section);
		return true;
	}

	all(): ConfigSection<unknown>[] {
		return [...this.byKey.values()];
	}

	keys(): string[] {
		return [...this.byKey.keys()];
	}
}
