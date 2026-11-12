import { config } from "./runtime.ts";
import { ioSection } from "./sections/io.ts";

export { Readable } from "node:stream";

export function ioTimeoutMs(): number {
	return config(ioSection).timeoutSec * 1000;
}

/** Abort on the caller's signal or after `ms` (default: the configured io timeout). */
export function ioTimeoutSignal(signal?: AbortSignal, ms = ioTimeoutMs()): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
